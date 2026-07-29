// ============================================================================
// pi 进程拉起
// ============================================================================
// - 未锁屏：GUI 终端（Ghostty / Terminal.app）→ interactive
// - 锁屏 / 强制后台：daemon 直接 spawn `pi --mode rpc`
//   （rpc 不依赖 TTY；stdin 用 pipe 挂住避免 EOF 退出；扩展照常 session_start 连 daemon）
//
// 不再依赖 tmux / script。

import { spawn, execFileSync, execSync, type ChildProcess } from 'node:child_process';
import { openSync, writeFileSync, closeSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { isScreenLocked } from './screen-lock.js';

export type SpawnMode = 'gui' | 'background';
/** background 实现：目前仅 daemon 内联 rpc */
export type BackgroundBackend = 'rpc';

export interface PiSpawnRequest {
  sessionId: string;
  /** pi --name */
  name?: string;
  /** 日志文件名前缀 */
  label?: string;
  /** 强制后台（忽略锁屏检测） */
  forceBackground?: boolean;
}

export type SpawnReason =
  | 'screen_locked_rpc'
  | 'force_background_rpc'
  | 'gui_available'
  | 'error';

export interface PiSpawnResult {
  ok: boolean;
  mode: SpawnMode;
  backend?: BackgroundBackend;
  scriptPath: string;
  logPath: string;
  /** 后台进程 pid（rpc） */
  childPid?: number;
  reason: SpawnReason;
  error?: string;
}

/** 挂住 rpc 子进程的 stdin，防止 pipe 被 GC/关闭导致进程退出 */
const retainedStdins = new Map<string, NodeJS.WritableStream>();
const retainedChildren = new Map<string, ChildProcess>();

export function resolvePiBin(): string {
  const candidates = [
    'pi',
    join(homedir(), '.npm-global', 'bin', 'pi'),
    '/usr/local/bin/pi',
    '/opt/homebrew/bin/pi',
  ];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 3_000 });
      return bin;
    } catch {
      // next
    }
  }
  return 'pi';
}

export function decideSpawnMode(opts?: {
  forceBackground?: boolean;
  locked?: boolean;
}): { mode: SpawnMode; reason: SpawnReason } {
  if (opts?.forceBackground) {
    return { mode: 'background', reason: 'force_background_rpc' };
  }
  const locked = opts?.locked ?? isScreenLocked();
  if (locked) {
    return { mode: 'background', reason: 'screen_locked_rpc' };
  }
  return { mode: 'gui', reason: 'gui_available' };
}

function buildGuiStartScript(params: {
  sessionId: string;
  name?: string;
  logPath: string;
  label: string;
}): string {
  const nameArg = params.name ? ` --name "${params.name.replace(/"/g, '\\"')}"` : '';
  return [
    '#!/bin/bash',
    `cd "${homedir()}" || exit 1`,
    `echo "启动 pi: ${params.label} ($(date '+%Y-%m-%d %H:%M:%S'))" >> "${params.logPath}"`,
    `pi --session-id "${params.sessionId}"${nameArg} --approve 2>>"${params.logPath}" || {`,
    `  echo "pi 启动失败，日志: ${params.logPath}" >> "${params.logPath}"`,
    '  sleep 2',
    '}',
    'rm -- "$0" 2>/dev/null',
    '',
  ].join('\n');
}

function writeScriptFile(label: string, content: string): string {
  const scriptPath = join(tmpdir(), `pi-start-${label}.sh`);
  writeFileSync(scriptPath, content, 'utf-8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function spawnGuiTerminal(scriptPath: string): void {
  try {
    execSync('ls /Applications/Ghostty.app > /dev/null 2>&1');
    console.log('[spawn] 使用 Ghostty 打开终端');
    const child = spawn('open', ['-na', 'Ghostty.app', '--args', '-e', scriptPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  } catch {
    // fall through
  }
  console.log('[spawn] 使用 Terminal.app 打开终端');
  const child = spawn('open', ['-a', 'Terminal.app', scriptPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/**
 * daemon 内联拉起 pi（rpc 模式，无 GUI / 无 tmux）
 */
function spawnRpcBackground(params: {
  sessionId: string;
  name?: string;
  logPath: string;
  label: string;
}): { pid: number; child: ChildProcess } {
  // 先清掉同 session 残留的 stdin 引用
  releaseRetainedChild(params.sessionId);

  const piBin = resolvePiBin();
  const args = [
    '--mode', 'rpc',
    '--session-id', params.sessionId,
    '--approve',
  ];
  if (params.name) {
    args.push('--name', params.name);
  }

  // 追加启动标记
  writeFileSync(params.logPath, '', { flag: 'a' });
  const bootLine = `启动 pi: ${params.label} (rpc ${new Date().toISOString()})\n`;
  writeFileSync(params.logPath, bootLine, { flag: 'a' });

  const logFd = openSync(params.logPath, 'a');
  console.log(`[spawn] 直接 spawn pi --mode rpc session=${params.sessionId.slice(0, 8)} bin=${piBin}`);

  const child = spawn(piBin, args, {
    cwd: homedir(),
    detached: true,
    // stdin=pipe 挂住，避免 EOF 触发 rpc shutdown；stdout/err 进日志
    stdio: ['pipe', logFd, logFd],
    env: process.env,
  });

  // fd 已交给子进程，父进程可关
  try { closeSync(logFd); } catch {}

  if (!child.pid) {
    throw new Error('spawn pi 未得到 pid');
  }

  if (child.stdin) {
    child.stdin.on('error', () => {});
    retainedStdins.set(params.sessionId, child.stdin);
  }
  retainedChildren.set(params.sessionId, child);

  child.on('exit', (code, signal) => {
    console.log(
      `[spawn] rpc pi 退出 session=${params.sessionId.slice(0, 8)} code=${code} signal=${signal}`,
    );
    releaseRetainedChild(params.sessionId);
  });

  // 允许 daemon 事件循环不因 child 引用而保持（stdin Map 仍持有 pipe）
  child.unref();

  return { pid: child.pid, child };
}

/** 释放挂住的 stdin / child 引用（不负责杀进程） */
export function releaseRetainedChild(sessionId: string): void {
  const stdin = retainedStdins.get(sessionId);
  if (stdin) {
    try { stdin.end(); } catch {}
    retainedStdins.delete(sessionId);
  }
  retainedChildren.delete(sessionId);
}

/** 结束后台 rpc 子进程 */
export function killBackgroundChild(sessionId: string, pid?: number): void {
  const child = retainedChildren.get(sessionId);
  const targetPid = pid ?? child?.pid;
  releaseRetainedChild(sessionId);
  if (targetPid) {
    try { process.kill(targetPid, 'SIGTERM'); } catch {}
    // 再保险：进程组（detached）
    try { process.kill(-targetPid, 'SIGTERM'); } catch {}
  }
}

/** @deprecated 兼容旧调用；rpc 路径无 tmux */
export function killTmuxSession(_sessionName: string): void {
  // no-op：后台已改为直接 spawn
}

/**
 * 按锁屏状态选择 GUI 或 daemon 内联 rpc 拉起 pi。
 */
export function spawnPiProcess(req: PiSpawnRequest): PiSpawnResult {
  const label = req.label || req.sessionId.slice(0, 8);
  const logPath = join(tmpdir(), `pi-start-${label}.log`);

  try {
    const decided = decideSpawnMode({ forceBackground: req.forceBackground });

    if (decided.mode === 'background') {
      const { pid } = spawnRpcBackground({
        sessionId: req.sessionId,
        name: req.name,
        logPath,
        label,
      });
      return {
        ok: true,
        mode: 'background',
        backend: 'rpc',
        scriptPath: '',
        logPath,
        childPid: pid,
        reason: decided.reason,
      };
    }

    // GUI
    const scriptContent = buildGuiStartScript({
      sessionId: req.sessionId,
      name: req.name,
      logPath,
      label,
    });
    const scriptPath = writeScriptFile(label, scriptContent);
    spawnGuiTerminal(scriptPath);

    return {
      ok: true,
      mode: 'gui',
      scriptPath,
      logPath,
      reason: 'gui_available',
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[spawn] 启动失败:', msg);
    return {
      ok: false,
      mode: 'background',
      scriptPath: '',
      logPath,
      reason: 'error',
      error: msg,
    };
  }
}
