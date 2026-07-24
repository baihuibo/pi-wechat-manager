// ============================================================================
// pi-wechat-manager 扩展
// ============================================================================

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { createConnection, Socket } from 'node:net';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Extension 安装目录（兼容 pi install 和手动安装）
const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = __dirname;

// Socket / PID / 日志等运行时数据目录
const MANAGER_DIR = join(homedir(), '.pi', 'agent', 'pi-wechat-manager');
const SOCKET_PATH = join(MANAGER_DIR, 'daemon.sock');
const PID_FILE = join(MANAGER_DIR, 'daemon.pid');
import { homedir } from 'node:os';
import qrcode from 'qrcode-terminal';
import { getQrCode, pollQrStatus } from './src/wechat-auth.js';
import { saveCredentials, DAEMON_VERSION, HTTP_PORT } from './src/config.js';
import { loadState, saveState, updateWechatStatus, updateSessionStatus, getAliases } from './src/state-store.js';

// 消息分块（微信单条消息限制约 4096 字符）
function splitMessage(text: string, maxLength = 4000): string[] {
  if (text.length <= maxLength) return [text];
  
  const chunks: string[] = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    
    // 尝试在换行符处分割
    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
    }
    
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }
  
  return chunks;
}

// 从文本中提取 URL
function extractUrl(text: string): string | null {
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  return urlMatch ? urlMatch[0] : null;
}

type Ctx = ExtensionContext | ExtensionCommandContext;

// ============================================================================
// 状态定义
// ============================================================================

enum WechatState {
  IDLE = 'IDLE',                          // 未连接守护进程
  DAEMON_CONNECTED = 'DAEMON_CONNECTED',  // 守护进程已连接，微信未登录
  WECHAT_LOGGED_IN = 'WECHAT_LOGGED_IN',  // 微信已登录，等待连接
  WECHAT_CONNECTED = 'WECHAT_CONNECTED',  // 微信完全连接
}

// ============================================================================
// Socket 客户端
// ============================================================================

class SocketClient {
  private socket: Socket | null = null;
  private pendingRequests: Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }> = new Map();
  private eventHandlers: Map<string, (data: any) => void> = new Map();
  private buffer: string = '';
  
  async connect(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('连接超时'));
      }, timeoutMs);
      
      this.socket = createConnection(SOCKET_PATH);
      
      this.socket.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      
      this.socket.on('data', (data) => {
        this.buffer += data.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.trim()) {
            try {
              const msg = JSON.parse(line);
              this.handleMessage(msg);
            } catch {}
          }
        }
      });
      
      this.socket.on('close', () => {
        this.socket = null;
      });
      
      this.socket.on('error', () => {
        clearTimeout(timer);
        reject(new Error('连接失败'));
      });
    });
  }
  
  private handleMessage(msg: any): void {
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const { resolve, reject } = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message));
      } else {
        resolve(msg.result);
      }
    }
    
    if (msg.event && this.eventHandlers.has(msg.event)) {
      this.eventHandlers.get(msg.event)!(msg.data);
    }
  }
  
  async request(method: string, params: any = {}): Promise<any> {
    if (!this.socket?.writable) {
      throw new Error('未连接到守护进程');
    }
    
    const id = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.socket!.write(JSON.stringify({ id, method, params }) + '\n');
      
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('请求超时'));
        }
      }, 10000);
    });
  }
  
  on(event: string, handler: (data: any) => void): void {
    this.eventHandlers.set(event, handler);
  }
  
  get connected(): boolean {
    return this.socket?.writable ?? false;
  }
  
  close(): void {
    this.socket?.end();
    this.socket = null;
  }
}

// ============================================================================
// 全局状态
// ============================================================================

let currentState: WechatState = WechatState.IDLE;
let socketClient: SocketClient | null = null;
let sessionId: string = '';
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let loginAbortController: AbortController | null = null;
let sessionName: string = '';

// 消息追踪
let lastWechatUser: string | null = null;
let wechatConversationActive = false;
let sentCount = 0;

// 任务进度追踪
let taskStartTime: number | null = null;
let progressMessages: string[] = [];

// ============================================================================
// 辅助函数
// ============================================================================

// ============================================================================
// 守护进程健康检查与启停
// ============================================================================

type DaemonHealth = 
  | { status: 'healthy'; version: string }
  | { status: 'version_mismatch'; runningVersion: string }
  | { status: 'unresponsive'; reason: string }
  | { status: 'zombie'; reason: string }
  | { status: 'not_running' };

// 读取 PID 文件中的 PID（含校验）
function readDaemonPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const raw = readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    if (!pid || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

// 检查 PID 对应进程是否存活
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 检查端口是否被占用（TCP 连接探测）
function checkPortOccupied(): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require('node:net') as typeof import('node:net');
    const sock = net.createConnection({ port: HTTP_PORT, timeout: 500 }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

// 通过 HTTP 获取守护进程版本（带超时）
function fetchDaemonVersion(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const http = require('node:http') as typeof import('node:http');
    const req = http.get(`http://localhost:${HTTP_PORT}/api/version`, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.version || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// 全面健康检查
async function checkDaemonHealth(): Promise<DaemonHealth> {
  const pid = readDaemonPid();

  // 1. 没有 PID 文件 → 未运行
  if (pid === null) {
    const portUsed = await checkPortOccupied();
    if (portUsed) {
      return { status: 'zombie', reason: `PID 文件缺失，但端口 ${HTTP_PORT} 被占用` };
    }
    return { status: 'not_running' };
  }

  // 2. PID 文件存在但进程已死 → 僵尸
  if (!isPidAlive(pid)) {
    return { status: 'zombie', reason: `PID ${pid} 已不存在` };
  }

  // 3. 进程存活，尝试 HTTP 获取版本
  const version = await fetchDaemonVersion(3000);

  // 4. HTTP 无响应 → 卡死
  if (version === null) {
    const portUsed = await checkPortOccupied();
    if (!portUsed) {
      return { status: 'unresponsive', reason: `进程 PID ${pid} 存活但端口 ${HTTP_PORT} 不可达（卡在启动中）` };
    }
    return { status: 'unresponsive', reason: `进程 PID ${pid} 存活但 HTTP 无响应（可能卡死）` };
  }

  // 5. 版本匹配 → 健康
  if (version === DAEMON_VERSION) {
    return { status: 'healthy', version };
  }

  // 6. 版本不匹配
  return { status: 'version_mismatch', runningVersion: version };
}

// 强制杀掉守护进程（SIGTERM → 等待 → SIGKILL → 清理残留）
async function killDaemon(): Promise<void> {
  const pid = readDaemonPid();

  // 1. 通过 PID 杀
  if (pid !== null && isPidAlive(pid)) {
    console.log(`[微信] 发送 SIGTERM → PID ${pid}`);
    try { process.kill(pid, 'SIGTERM'); } catch {}

    // 等 1.5s，检查退出
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (!isPidAlive(pid)) {
        console.log(`[微信] PID ${pid} 已退出 (SIGTERM)`);
        break;
      }
    }

    // SIGKILL 兜底
    if (isPidAlive(pid)) {
      console.log(`[微信] SIGTERM 无效，发送 SIGKILL → PID ${pid}`);
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await new Promise(r => setTimeout(r, 1000));

      if (isPidAlive(pid)) {
        console.log(`[微信] ⚠️ PID ${pid} 无法杀死，需手动处理`);
      }
    }
  }

  // 2. 清理 PID 文件
  try { unlinkSync(PID_FILE); } catch {}

  // 3. 清理 socket 文件
  try { unlinkSync(SOCKET_PATH); } catch {}

  // 4. 等待端口释放
  for (let i = 0; i < 10; i++) {
    const used = await checkPortOccupied();
    if (!used) {
      console.log(`[微信] 端口 ${HTTP_PORT} 已释放`);
      return;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[微信] ⚠️ 端口 ${HTTP_PORT} 仍被占用，跳过等待`);
}

async function startDaemon(): Promise<boolean> {
  console.log(`[微信] 健康检查...`);
  const health = await checkDaemonHealth();

  switch (health.status) {
    case 'healthy':
      console.log(`[微信] 守护进程健康 (v${health.version})，跳过重启`);
      return true;

    case 'version_mismatch':
      console.log(`[微信] 版本不匹配 (运行 v${health.runningVersion} → 当前 v${DAEMON_VERSION})，重启中...`);
      await killDaemon();
      break;

    case 'unresponsive':
      console.log(`[微信] 守护进程无响应: ${health.reason}`);
      await killDaemon();
      break;

    case 'zombie':
      console.log(`[微信] 僵尸进程: ${health.reason}`);
      await killDaemon();
      break;

    case 'not_running':
      console.log(`[微信] 守护进程未运行，启动中...`);
      break;
  }

  // 起新进程
  const { spawn } = await import('node:child_process');
  const { mkdirSync, openSync } = await import('node:fs');

  const daemonScript = join(EXTENSION_DIR, 'src', 'daemon.ts');
  const logFile = join(MANAGER_DIR, 'daemon.log');
  const logDir = MANAGER_DIR;

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const logFd = openSync(logFile, 'a');
  const tsxLoader = require.resolve('tsx');
  const nodeBin = resolveNodeBinary();
  const child = spawn(nodeBin, ['--import', tsxLoader, daemonScript], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: EXTENSION_DIR,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

  child.unref();
  console.log(`[微信] 子进程已启动 (PID: ${child.pid})`);

  // 等待 socket + HTTP 就绪（最多 10s）
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (existsSync(SOCKET_PATH)) {
      // socket 出现后再等 500ms 确保 HTTP server 启动
      await new Promise(r => setTimeout(r, 500));
      console.log(`[微信] 守护进程启动成功`);
      return true;
    }
  }

  console.log(`[微信] 守护进程启动超时 (10s)`);
  return false;
}

// 快速检查（用于自动重连）
function isDaemonRunning(): boolean {
  const pid = readDaemonPid();
  if (pid === null) return false;
  return isPidAlive(pid);
}

function resolveNodeBinary(): string {
  if (existsSync(process.execPath)) return process.execPath;
  try {
    const nodePath = execSync('which node 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (nodePath && existsSync(nodePath)) return nodePath;
  } catch {}
  const candidates = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error('找不到可用的 Node.js');
}

// 自动重连：守护进程在就自动连上
async function ensureConnected(): Promise<void> {
  if (socketClient?.connected) return;
  if (!isDaemonRunning()) return;
  await connectToDaemon();
}

function updateStatusBar(ctx: ExtensionContext) {
  switch (currentState) {
    case WechatState.IDLE:
    case WechatState.DAEMON_CONNECTED:
      ctx.ui.setStatus('wechat', '');
      break;
    case WechatState.WECHAT_LOGGED_IN: {
      ctx.ui.setStatus('wechat', sessionName ? `微信已登录 (${sessionName})` : '微信已登录');
      break;
    }
    case WechatState.WECHAT_CONNECTED: {
      const displayId = sessionName ? `@${sessionName}` : `@${sessionId.slice(0, 8)}`;
      const active = wechatConversationActive ? '🟢' : '⚪';
      ctx.ui.setStatus('wechat', `📱 微信已连接 ${active} ${displayId} 通信`);
      break;
    }
  }
}

// 尝试加载 session 名称（单次尝试，不重试）
// 读 session 文件 → 注册别名 → 更新状态栏；失败则尝试从别名表反向加载
async function tryLoadSessionName(ctx?: Ctx): Promise<void> {
  if (sessionName) return;

  // 1. 从 session 文件读 pi --name
  try {
    const { getSession } = await import('./src/session-discover.js');
    const info = getSession(sessionId);
    if (info?.name) {
      sessionName = info.name;
      console.log(`[微信] 从 session 文件加载名称: ${sessionName}`);
      if (socketClient?.connected) {
        socketClient.request('set_alias', { name: sessionName, sessionId }).catch(() => {});
      }
      if (ctx) updateStatusBar(ctx as ExtensionContext);
      return;
    }
  } catch {}

  // 2. 从守护进程别名表反向加载
  if (socketClient?.connected) {
    try {
      const aliases = await socketClient.request('get_aliases', {}) as Record<string, string>;
      for (const [alias, sid] of Object.entries(aliases)) {
        if (sid === sessionId) {
          sessionName = alias;
          console.log(`[微信] 从别名表加载名称: ${sessionName}`);
          if (ctx) updateStatusBar(ctx as ExtensionContext);
          break;
        }
      }
    } catch {}
  }
}

// ============================================================================
// 连接守护进程
// ============================================================================

async function connectToDaemon(ctx?: Ctx): Promise<boolean> {
  try {
    socketClient = new SocketClient();
    await socketClient.connect(5000);
    
    const defaultCtx = ctx || { cwd: process.cwd() } as Ctx;
    setupMessageHandler(socketClient, defaultCtx);
    
    const result = await socketClient.request('register', {
      sessionId,
      pid: process.pid,
      cwd: defaultCtx.cwd,
      name: sessionName || undefined,
    }) as any;
    
    heartbeatTimer = setInterval(async () => {
      try {
        await socketClient?.request('heartbeat', { sessionId });
      } catch {
        currentState = WechatState.IDLE;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (isDaemonRunning()) {
          try {
            const reconnected = await connectToDaemon(ctx);
            if (reconnected) currentState = WechatState.DAEMON_CONNECTED;
          } catch {}
        }
        if (ctx) updateStatusBar(ctx);
      }
    }, 30000);
    
    if (result.wechat?.loggedIn && result.wechat?.connected) {
      currentState = WechatState.WECHAT_CONNECTED;
    } else if (result.wechat?.loggedIn) {
      currentState = WechatState.WECHAT_LOGGED_IN;
    } else {
      currentState = WechatState.DAEMON_CONNECTED;
    }
    
    // 连接成功后顺手加载名称
    tryLoadSessionName(ctx);
    
    updateWechatStatus({
      loggedIn: result.wechat?.loggedIn || false,
      connected: result.wechat?.connected || false,
      running: result.wechat?.running || false,
      accountId: result.wechat?.accountId,
      userId: result.wechat?.userId,
    });
    
    if (ctx) updateStatusBar(ctx);
    return true;
  } catch (e) {
    socketClient = null;
    return false;
  }
}

// ============================================================================
// 设置消息处理器
// ============================================================================

function setupMessageHandler(client: SocketClient, ctx: Ctx) {
  client.on('wechat_message', (data) => {
    const { userId, text, images } = data;
    lastWechatUser = userId;
    wechatConversationActive = true;
    sentCount = 0;
    
    // 通信时顺手检查名称是否已就绪
    tryLoadSessionName();
    
    const content: any[] = [];
    if (text) content.push({ type: 'text', text: `[微信消息] ${text}` });
    if (images?.length) {
      for (const img of images) {
        try {
          const imageData = readFileSync(img);
          const ext = img.split('.').pop()?.toLowerCase() || 'png';
          const mime = ext === 'jpg' ? 'jpeg' : ext;
          content.push({ type: 'image', data: imageData.toString('base64'), mimeType: `image/${mime}` });
        } catch (e) { console.error('读取图片失败:', e); }
      }
    }
    
    if (content.length > 0 && globalPi) {
      globalPi.sendUserMessage(content.length === 1 && content[0].type === 'text' ? content[0].text : content, { deliverAs: 'followUp' });
    }
  });
  
  client.on('wechat_command', async (data) => {
    const { command, args, userId } = data;
    
    switch (command) {
      case 'help': {
        const helpText = [
          '**📱 微信可用命令**', '',
          '**💬 消息**', '直接发 → 发给默认 pi', '@[唯一标识] 消息 → 发给指定 pi', '',
          '**📂 Session**', '/new [唯一标识] [消息] → 新建 pi', '/new /path [唯一标识] [消息] → 指定目录', '/switch [唯一标识] → 切换默认 pi', '/sessions → 列出所有 pi', '',
          '**🎛️ 控制**', '/stop [唯一标识] → 中断操作', '/kill [唯一标识] → 终止进程', '/progress [唯一标识] → 查看进度', '',
          '**🤖 AI**', '/model [模型名] → 列出/切换模型', '/context → 查询上下文用量', '/compact → 压缩上下文', '',
          '**🏷️ 别名**', '/alias → 列出所有别名（完整 sessionId）', '/alias [名字] → 查询/设置（已存在=查ID，不存在=起名）', '',
          '**⏰ 定时**', '/cron → 查看定时任务', '/cron remove [名字] → 删除', '',
          '**📊 其他**', '/status → 连接状态',
        ].join('\n');
        if (socketClient) await socketClient.request('send_to_wechat', { userId, text: helpText });
        break;
      }
      
      case 'status': {
        if (socketClient) {
          const status = await socketClient.request('get_status', {});
          const statusText = ['📊 状态：', `微信：${status.wechat?.connected ? '已连接' : '未连接'}`, `Session：${sessionId.slice(0, 8)}...`].join('\n');
          await socketClient.request('send_to_wechat', { userId, text: statusText });
        }
        break;
      }
      
      case 'sessions': {
        if (socketClient) {
          const sessions = await socketClient.request('get_sessions', {});
          const sessionList = sessions.map((s: any) => {
            const name = s.name || s.id.slice(0, 8);
            const active = s.isActive ? '🟢' : '⚪';
            return `${active} ${name}`;
          }).join('\n');
          await socketClient.request('send_to_wechat', { userId, text: `📋 Sessions：\n${sessionList}` });
        }
        break;
      }
      
      case 'alias': {
        if (socketClient) {
          const [name, targetSession] = args.split(/\s+/);
          if (!name) {
            const aliases = await socketClient.request('get_aliases', {});
            const aliasList = Object.entries(aliases).map(([k, v]) => `@${k} → ${(v as string).slice(0, 8)}...`).join('\n');
            await socketClient.request('send_to_wechat', { userId, text: aliasList ? `📋 别名：\n${aliasList}` : '没有设置别名' });
          } else if (!targetSession) {
            const result = await socketClient.request('set_alias', { name, sessionId }) as any;
            if (result.updated) {
              await socketClient.request('send_to_wechat', { userId, text: `⚠️ @${name} 之前指向 ${(result.previousSession as string).slice(0, 8)}，已更新 → ${sessionId.slice(0, 8)}` });
            } else {
              await socketClient.request('send_to_wechat', { userId, text: `✅ 已设置别名：@${name} → ${sessionId.slice(0, 8)}...` });
            }
          } else {
            const result = await socketClient.request('set_alias', { name, sessionId: targetSession }) as any;
            if (result.updated) {
              await socketClient.request('send_to_wechat', { userId, text: `⚠️ @${name} 之前指向 ${(result.previousSession as string).slice(0, 8)}，已更新 → ${targetSession.slice(0, 8)}` });
            } else {
              await socketClient.request('send_to_wechat', { userId, text: `✅ 已设置别名：@${name} → ${targetSession.slice(0, 8)}...` });
            }
          }
        }
        break;
      }
      
      case 'stop': {
        if (ctx && !ctx.isIdle()) {
          ctx.abort();
          if (socketClient) await socketClient.request('send_to_wechat', { userId, text: '⏹️ 已中断' });
        } else if (socketClient) {
          await socketClient.request('send_to_wechat', { userId, text: '⏹️ 当前无运行任务' });
        }
        break;
      }
      
      case 'reset':
      case 'compact': {
        if (ctx && socketClient) {
          const sc = socketClient;
          await sc.request('send_to_wechat', { userId, text: '♻️ 开始压缩上下文...' });
          ctx.compact({
            onComplete: () => { sc.request('send_to_wechat', { userId, text: '✅ 上下文压缩完成' }).catch(() => {}); },
            onError: (e: any) => { sc.request('send_to_wechat', { userId, text: `❌ 压缩失败: ${e.message}` }).catch(() => {}); },
          });
        }
        break;
      }
      
      case 'context': {
        const alias = args?.alias;
        if (alias && alias !== 'undefined') {
          if (socketClient) await socketClient.request('send_to_wechat', { userId, text: '⚠️ /context <别名> 暂不支持跨 session，请用 @别名 切换' });
        } else if (ctx) {
          try {
            const usage = ctx.getContextUsage();
            if (usage && usage.tokens > 0) {
              const percent = usage.percent !== undefined ? Math.round(usage.percent) : '?';
              let text = `**📊 上下文用量**\n\n- Tokens: ${usage.tokens.toLocaleString()}\n`;
              if (usage.percent !== undefined) {
                text += `- 使用率: ${percent}%\n`;
                const bar = '█'.repeat(Math.min(Math.round(usage.percent / 5), 20));
                const empty = '░'.repeat(20 - bar.length);
                text += `- [${bar}${empty}]\n`;
              }
              if (usage.percent !== undefined && usage.percent > 70) text += '\n⚠️ 建议 /compact';
              if (socketClient) await socketClient.request('send_to_wechat', { userId, text });
            } else if (socketClient) {
              await socketClient.request('send_to_wechat', { userId, text: '📊 暂无上下文数据' });
            }
          } catch (e: any) {
            if (socketClient) await socketClient.request('send_to_wechat', { userId, text: `❌ 查询失败: ${e.message}` });
          }
        }
        break;
      }
      
      case 'model': {
        const modelName = args?.modelName;
        if (!modelName) {
          try {
            if (ctx && ctx.modelRegistry) {
              let listText = '**🤖 可用模型：**\n\n';
              const { readFileSync, existsSync } = await import('node:fs');
              const { homedir } = await import('node:os');
              const { join } = await import('node:path');
              const modelsPath = join(homedir(), '.pi', 'agent', 'models-store.json');
              if (existsSync(modelsPath)) {
                const store = JSON.parse(readFileSync(modelsPath, 'utf-8'));
                const allModels: string[] = [];
                for (const [provider, data] of Object.entries(store) as any) {
                  for (const m of (data as any).models || []) allModels.push(`- ${m.id}`);
                }
                listText += allModels.slice(0, 20).join('\n') + '\n\n输入 /model <名称> 切换';
              } else {
                listText += '（未找到模型配置）';
              }
              if (socketClient) await socketClient.request('send_to_wechat', { userId, text: listText });
            }
          } catch (e: any) {
            if (socketClient) await socketClient.request('send_to_wechat', { userId, text: `❌ 读取模型失败: ${e.message}` });
          }
        } else if (globalPi && ctx) {
          try {
            const { readFileSync, existsSync } = await import('node:fs');
            const { homedir } = await import('node:os');
            const { join } = await import('node:path');
            const modelsPath = join(homedir(), '.pi', 'agent', 'models-store.json');
            let provider = '';
            if (existsSync(modelsPath)) {
              const store = JSON.parse(readFileSync(modelsPath, 'utf-8'));
              for (const [pid, data] of Object.entries(store) as any) {
                for (const m of (data as any).models || []) {
                  if (m.id === modelName) { provider = pid; break; }
                }
                if (provider) break;
              }
            }
            if (!provider) {
              if (socketClient) await socketClient.request('send_to_wechat', { userId, text: `❌ 未找到模型: ${modelName}` });
              break;
            }
            const model = ctx.modelRegistry.find(provider, modelName);
            if (!model) {
              if (socketClient) await socketClient.request('send_to_wechat', { userId, text: `❌ 无法加载模型: ${modelName}` });
              break;
            }
            const success = await globalPi.setModel(model);
            if (socketClient) await socketClient.request('send_to_wechat', { userId, text: success ? `✅ 已切换到 ${modelName}` : `❌ 切换失败（可能缺少 API key）` });
          } catch (e: any) {
            if (socketClient) await socketClient.request('send_to_wechat', { userId, text: `❌ 切换失败: ${e.message}` });
          }
        }
        break;
      }
    }
  });
}

// ============================================================================
// 微信登录流程
// ============================================================================

function cancelLogin(ctx: ExtensionContext) {
  if (loginAbortController) {
    loginAbortController.abort();
    loginAbortController = null;
    ctx.ui.notify('登录已取消', 'warning');
  }
}

function generateQrText(url: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(url, { small: true }, (code) => resolve(code));
  });
}

async function startLoginFlow(ctx: ExtensionCommandContext): Promise<boolean> {
  cancelLogin(ctx);
  loginAbortController = new AbortController();
  const signal = loginAbortController.signal;
  
  let qr: { url: string; token: string };
  try {
    ctx.ui.notify('正在获取二维码...', 'info');
    qr = await getQrCode();
    if (!qr || !qr.url) { ctx.ui.notify('获取二维码失败', 'error'); return false; }
  } catch (e: any) {
    ctx.ui.notify(`获取二维码失败：${e.message}`, 'error');
    return false;
  }
  
  const qrText = await generateQrText(qr.url);
  ctx.ui.notify(`请用微信扫码登录：\n\n${qrText}\n\n二维码链接：${qr.url}`, 'info');
  
  let currentBaseUrl: string | undefined;
  let lastStatus = '';
  let refreshCount = 0;
  
  for (let i = 0; i < 90; i++) {
    if (signal.aborted) return false;
    await new Promise(r => setTimeout(r, 2000));
    if (signal.aborted) return false;
    
    try {
      const result = await pollQrStatus(qr.token, currentBaseUrl);
      if (result.redirectHost) currentBaseUrl = `https://${result.redirectHost}`;
      
      if (result.status !== lastStatus) {
        lastStatus = result.status;
        if (result.status === 'scaned') ctx.ui.notify('已扫码，请在手机上确认登录', 'info');
      }
      
      if (result.status === 'confirmed' && result.credentials) {
        await saveCredentials(result.credentials);
        ctx.ui.notify('微信登录成功 ✅', 'info');
        currentState = WechatState.WECHAT_CONNECTED;
        updateStatusBar(ctx);
        if (socketClient) {
          try { await socketClient.request('wechat_login_success', { credentials: result.credentials }); } catch {}
        }
        return true;
      }
      
      if (result.status === 'expired') {
        refreshCount++;
        if (refreshCount >= 3) { ctx.ui.notify('二维码多次过期，请重新执行 /wechat start', 'error'); return false; }
        ctx.ui.notify('二维码已过期，正在刷新...', 'info');
        try {
          qr = await getQrCode(currentBaseUrl);
          const newQrText = await generateQrText(qr.url);
          ctx.ui.notify(`请重新扫码：\n\n${newQrText}\n\n二维码链接：${qr.url}`, 'info');
          lastStatus = '';
        } catch (e: any) { ctx.ui.notify(`刷新失败：${e.message}`, 'error'); }
      }
    } catch (e: any) { console.error('轮询失败:', e.message); }
  }
  
  ctx.ui.notify('登录超时，请重新执行 /wechat start', 'error');
  return false;
}

let globalPi: ExtensionAPI | null = null;

// ============================================================================
// 扩展入口
// ============================================================================

export default function wechatManager(pi: ExtensionAPI) {
  globalPi = pi;
  
  // ===== pi 启动时静默连接 =====
  pi.on('session_start', async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    
    // 从 process.argv 读取 --name（最可靠，不依赖 session 文件写入时序）
    if (!sessionName) {
      const argv = process.argv;
      const idx = argv.indexOf('--name');
      if (idx !== -1 && idx + 1 < argv.length) {
        sessionName = argv[idx + 1];
        console.log(`[微信] 从进程参数读取名称: ${sessionName}`);
        updateStatusBar(ctx);
      }
    }
    
    // 静默连接
    if (isDaemonRunning()) {
      const connected = await connectToDaemon(ctx);
      if (!connected) {
        currentState = WechatState.IDLE;
      }
    }
    
    // 兜底：500ms/1s 后再从 session 文件尝试（覆盖极端时序）
    setTimeout(() => tryLoadSessionName(ctx), 500);
    setTimeout(() => tryLoadSessionName(ctx), 1000);
  });
  
  // ===== /wechat 命令 =====
  pi.registerCommand('wechat', {
    description: '微信桥接管理',
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      const restArgs = rest.join(' ');
      
      switch (sub) {
        // ===== START =====
        case 'start': {
          // 静默确保连接：守护进程在就自动连，不在就启动
          const daemonRunning = isDaemonRunning();
          
          if (!daemonRunning) {
            ctx.ui.setStatus('wechat', '⏳ 启动守护进程...');
            const started = await startDaemon();
            if (!started) {
              ctx.ui.setStatus('wechat', '');
              ctx.ui.notify('启动守护进程失败', 'error');
              return;
            }
          }
          
          if (!socketClient?.connected) {
            const connected = await connectToDaemon(ctx);
            if (!connected) {
              ctx.ui.notify('连接守护进程失败', 'error');
              return;
            }
          }
          
          // 3. 检查微信状态
          if (currentState === WechatState.WECHAT_CONNECTED) {
            ctx.ui.notify('✅ 微信已连接', 'info');
            return;
          }
          
          // 4. 检查是否已有凭证（守护进程可能正在登录中）
          try {
            const status = await socketClient!.request('get_wechat_status', {}) as any;
            if (status?.loggedIn && status?.connected) {
              currentState = WechatState.WECHAT_CONNECTED;
              updateStatusBar(ctx);
              ctx.ui.notify('✅ 微信已连接', 'info');
              return;
            }
            if (status?.loggedIn && !status?.connected) {
              currentState = WechatState.WECHAT_LOGGED_IN;
              updateStatusBar(ctx);
              ctx.ui.notify('微信已登录，正在等待连接...', 'info');
              return;
            }
          } catch {}
          
          // 5. 需要登录，显示二维码
          ctx.ui.notify('微信未登录，正在获取二维码...', 'warning');
          await startLoginFlow(ctx);
          break;
        }
        
        // ===== KEEP =====
        // ===== STOP =====
        case 'stop': {
          // 取消登录
          cancelLogin(ctx);
          
          // 停止心跳
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          
          // 退出微信登录（清除凭证）
          if (socketClient?.connected) {
            try {
              await socketClient.request('wechat_logout', {});
            } catch {}
          }
          
          // 断开连接
          if (socketClient) {
            try {
              await socketClient.request('unregister', { sessionId });
            } catch {}
            socketClient.close();
            socketClient = null;
          }
          
          // 停止守护进程
          const { readFileSync, existsSync } = await import('node:fs');
          const { join } = await import('node:path');
          const { homedir } = await import('node:os');
          const pidFile = join(homedir(), '.pi', 'agent', 'pi-wechat-manager', 'daemon.pid');
          
          if (existsSync(pidFile)) {
            try {
              const pid = parseInt(readFileSync(pidFile, 'utf-8'));
              
              // 检查进程是否存在
              try {
                process.kill(pid, 0); // 检查进程是否存在
                
                // 进程存在，发送 SIGTERM 信号
                process.kill(pid, 'SIGTERM');
                
                // 等待进程退出
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // 检查进程是否还在
                try {
                  process.kill(pid, 0);
                  // 还在，强制杀死
                  process.kill(pid, 'SIGKILL');
                } catch {
                  // 进程已经退出
                }
                
                ctx.ui.notify('✅ 守护进程已停止', 'info');
              } catch {
                // 进程不存在，清理 PID 文件
                ctx.ui.notify('ℹ️ 守护进程未运行', 'info');
              }
            } catch (e) {
              ctx.ui.notify('⚠️ 读取 PID 文件失败', 'warning');
            }
          } else {
            ctx.ui.notify('ℹ️ 守护进程未运行', 'info');
          }
          
          currentState = WechatState.IDLE;
          updateStatusBar(ctx);
          break;
        }
        
        // ===== CANCEL =====
        // ===== LOGOUT =====
        // ===== STATUS =====
        // ===== STATUS =====
        case 'status': {
          const daemonRunning = isDaemonRunning();
          
          let daemonStatus: any = null;
          if (socketClient?.connected) {
            try {
              daemonStatus = await socketClient.request('get_status', {});
            } catch {}
          }
          
          const wechatLoggedIn = daemonStatus?.wechat?.loggedIn || false;
          const wechatConnected = daemonStatus?.wechat?.connected || false;
          
          const lines = [
            '═══════════════════════════',
            '  📱 微信桥接状态',
            '═══════════════════════════',
            '',
            `守护进程: ${daemonRunning ? '✅ 运行中' : '❌ 未启动'}`,
            `微信: ${wechatConnected ? '✅ 已连接' : wechatLoggedIn ? '已登录，连接中...' : '❌ 未登录'}`,
            `当前 session: ${sessionId.slice(0, 8)}...`,
          ];
          
          if (daemonStatus?.connections?.length) {
            lines.push('', '连接的 pi 实例：');
            for (const conn of daemonStatus.connections) {
              const isCurrent = conn.sessionId === sessionId;
              lines.push(`  ${isCurrent ? '→' : ' '} ${conn.sessionId.slice(0, 8)}... (PID: ${conn.pid})`);
            }
          }
          
          if (currentState === WechatState.IDLE) {
            lines.push('', '💡 执行 /wechat start 启动');
          } else if (currentState === WechatState.DAEMON_CONNECTED) {
            lines.push('', '💡 执行 /wechat start 登录微信');
          }
          
          ctx.ui.notify(lines.join('\n'), 'info');
          break;
        }
        
        // ===== SESSIONS =====
        case 'sessions': {
          // 直接读取本地 session 文件，不需要守护进程
          const { listSessions } = await import('./src/session-discover.js');
          const { summarizeSessions } = await import('./src/llm-summarizer.js');
          
          try {
            ctx.ui.notify('正在汇总 sessions...', 'info');
            const sessions = listSessions();
            
            if (sessions.length === 0) {
              ctx.ui.notify('没有找到 session', 'info');
              return;
            }
            
            // 获取活跃 session 列表
            const activeSessions = new Set<string>();
            if (socketClient?.connected) {
              try {
                const status = await socketClient.request('get_status', {}) as any;
                if (status.connections) {
                  for (const conn of status.connections) {
                    activeSessions.add(conn.sessionId);
                  }
                }
              } catch {}
            }
            
            // 排序：活跃的在前
            const sortedSessions = [...sessions].sort((a, b) => {
              const aActive = activeSessions.has(a.id);
              const bActive = activeSessions.has(b.id);
              if (aActive && !bActive) return -1;
              if (!aActive && bActive) return 1;
              return b.modified.getTime() - a.modified.getTime();
            });
            
            // 批量摘要（最多 20 个）
            const summaries = await summarizeSessions(
              sortedSessions.slice(0, 20).map(s => ({ path: s.path, name: s.name }))
            );
            
            const lines = sortedSessions.slice(0, 20).map((s, i) => {
              const isActive = activeSessions.has(s.id);
              const status = isActive ? '🟢' : '⚪';
              const summary = summaries.get(s.path) || '';
              const time = new Date(s.modified).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' });
              const id = s.id;
              return summary 
                ? `${status} ${id}\n   ${summary} (${time})` 
                : `${status} ${id} (${time})`;
            });
            
            ctx.ui.notify(`📋 Sessions（${sortedSessions.length}）：\n\n${lines.join('\n\n')}\n\n💡 使用 /wechat switch <id> 切换 session`, 'info');
          } catch (e: any) {
            ctx.ui.notify(`获取失败：${e.message}`, 'error');
          }
          break;
        }
        
        // ===== ALIAS =====
        case 'alias': {
          if (!socketClient?.connected) {
            ctx.ui.notify('微信未连接，请先执行 /wechat start', 'error');
            return;
          }
          const [name, targetSession] = restArgs.split(/\s+/);
          const aliases = await socketClient.request('get_aliases', {}) as Record<string, string>;
          
          if (!name) {
            // 无参数：显示当前别名 + 全部别名表
            const currentAlias = Object.entries(aliases).find(([_, v]) => v === sessionId);
            const lines: string[] = [];
            if (currentAlias) {
              lines.push(`当前 session 别名: @${currentAlias[0]}`);
            } else if (sessionName) {
              lines.push(`当前 session 名称: @${sessionName} (仅本地，未存入别名表)`);
            } else {
              lines.push(`当前 session: ${sessionId.slice(0, 8)}... (无别名)`);
            }
            
            if (Object.keys(aliases).length > 0) {
              lines.push('');
              lines.push('**全部别名：**');
              for (const [k, v] of Object.entries(aliases)) {
                lines.push(`  @${k} → ${v.slice(0, 8)}...`);
              }
            }
            
            ctx.ui.notify(lines.join('\n'), 'info');
            if (!currentAlias && !sessionName) {
              ctx.ui.notify('用法: /wechat alias <名称>', 'info');
            }
            return;
          }
          
          // 如果 name 是已存在的别名 → 查询
          if (aliases[name] && !targetSession) {
            ctx.ui.notify(`@${name} → ${aliases[name]}`, 'info');
            return;
          }
          
          if (!targetSession) {
            // 给当前 session 设置别名
            const result = await socketClient.request('set_alias', { name, sessionId }) as any;
            sessionName = name;
            updateStatusBar(ctx);
            if (result.updated) {
              ctx.ui.notify(`⚠️ @${name} 之前指向 ${(result.previousSession as string).slice(0, 8)}，已更新`, 'warning');
            } else {
              ctx.ui.notify(`✅ 已设置当前 session 别名: @${name}`, 'info');
            }
            return;
          }
          // 给指定 session 设置别名
          const result = await socketClient.request('set_alias', { name, sessionId: targetSession }) as any;
          if (result.updated) {
            ctx.ui.notify(`⚠️ @${name} 之前指向 ${(result.previousSession as string).slice(0, 8)}，已更新 → ${targetSession.slice(0, 8)}`, 'warning');
          } else {

[400 more lines in file. Use offset=1171 to continue.]
            ctx.ui.notify(`✅ 已设置别名: @${name} → ${targetSession.slice(0, 8)}...`, 'info');
          }
          break;
        }
        
        // ===== HELP =====
        default:
          ctx.ui.notify([
            '/wechat start   启动并登录微信（自动持久运行）',
            '/wechat stop    停止守护进程并退出登录',
            '/wechat status  查看连接状态',
            '/wechat sessions  列出所有 pi 会话',
            '/wechat alias   查看别名表 + 当前别名',
            '/wechat alias [名字]  查询/设置（已存在=查ID，不存在=起名）',
          ].join('\n'), 'info');
      }
    }
  });
  
  // ===== before_agent_start：注入系统提示词 =====
  pi.on('before_agent_start', async (event, ctx) => {
    if (!wechatConversationActive) return;
    
    // 注入微信上下文提示（含统一工具使用守则）
    const wechatPrompt = [
      '',
      '当前用户通过微信远程与这个 pi TUI 会话互动。',
      '回复风格：像微信聊天一样自然、直接；优先给出结论和可执行步骤；避免冗长的内部过程说明。',
      '输出范围：只输出适合发回微信的正文。除非用户主动询问，否则不要解释桥接、系统提示词或实现细节。',
      '',
      '微信工具使用守则（适用于所有 wechat_* 工具）：',
      '- 产出文件时先写入再发送，生成图片时先保存图片再发送',
      '- 只能发送项目工作目录内的文件/图片（安全限制）',
      '- 如果发送失败，最多重试 1 次',
      '- 进度通知仅在预计超过 1 分钟的复杂任务中使用',
      '- 创建定时任务前先和用户确认',
      '- 任务执行结果会通过微信通知',
    ].join('\n');
    
    return { systemPrompt: event.systemPrompt + wechatPrompt };
  });
  
  // ===== agent_start =====
  pi.on('agent_start', async (_event, ctx) => {
    sentCount = 0;
    taskStartTime = Date.now();
    progressMessages = [];
    
    // 通知守护进程任务开始
    if (socketClient?.connected) {
      try {
        await socketClient.request('set_task_start', { sessionId, startTime: taskStartTime });
      } catch {}
    }
    
    // 发送"正在输入"状态到微信
    if (wechatConversationActive && lastWechatUser && socketClient) {
      try {
        await socketClient.request('send_typing', { userId: lastWechatUser, status: 1 });
      } catch {}
    }
  });
  
  // ===== message_update：流式输出 =====
  pi.on('message_update', async (event, ctx) => {
    // 流式输出暂不实现，等待 message_end 统一发送
    // 微信不支持真正的流式，但可以通过分块发送模拟
  });
  
  // ===== message_end：发送回复到微信 =====
  pi.on('message_end', async (event, ctx) => {
    if (!wechatConversationActive || !lastWechatUser) return;
    if (event.message.role !== 'assistant') return;
    if (currentState !== WechatState.WECHAT_CONNECTED || !socketClient) return;
    
    // 停止"正在输入"状态
    try {
      await socketClient.request('send_typing', { userId: lastWechatUser, status: 2 });
    } catch {}
    
    const content = event.message.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    }
    
    if (!text) return;
    
    // 添加 session 名称前缀（优先显示别名）
    const displayName = sessionName ? `@${sessionName}` : `@${sessionId.slice(0, 8)}`;
    const prefixedText = `**${displayName}：**\n\n${text}`;
    
    try {
      // 分块发送（微信有消息长度限制）
      const chunks = splitMessage(prefixedText);
      for (const chunk of chunks) {
        await socketClient.request('send_to_wechat', { 
          userId: lastWechatUser, 
          text: chunk 
        });
      }
      sentCount++;
    } catch (e) {
      console.error('发送回复失败:', e);
    }
  });
  
  // ===== agent_end：发送完成通知 =====
  pi.on('agent_end', async (event, ctx) => {
    if (!wechatConversationActive || !lastWechatUser || !socketClient) return;
    
    // 计算任务总运行时间
    const runtime = taskStartTime ? Math.floor((Date.now() - taskStartTime) / 1000) : 0;
    const runtimeText = runtime > 60 ? `${Math.floor(runtime / 60)} 分钟` : `${runtime} 秒`;
    const displayName = sessionName || sessionId.slice(0, 8);
    
    // 如果有进度消息，发送完成通知
    if (progressMessages.length > 0) {
      try {
        await socketClient.request('send_to_wechat', { 
          userId: lastWechatUser, 
          text: `✅ @${displayName}: 任务完成（共耗时 ${runtimeText}）` 
        });
      } catch {}
    }
    
    // 清除守护进程中的进度
    try {
      await socketClient.request('clear_progress', { sessionId });
    } catch {}
    
    // 重置任务追踪
    taskStartTime = null;
    progressMessages = [];
  });
  
  // ===== agent_settled：重置对话状态 + 上下文告警 =====
  pi.on('agent_settled', async (_event, ctx) => {
    wechatConversationActive = false;
    
    // 检查上下文使用率
    try {
      if (lastWechatUser && socketClient) {
        const usage = ctx.getContextUsage();
        if (usage && usage.tokens > 0 && usage.percent !== undefined && usage.percent > 70) {
          await socketClient.request('send_to_wechat', {
            userId: lastWechatUser,
            text: `⚠️ 上下文使用 ${Math.round(usage.percent)}%（${usage.tokens.toLocaleString()} tokens），建议 /compact`,
          });
        }
      }
    } catch {}
  });
  
  // ===== 注册工具 =====
  pi.registerTool({
    name: 'wechat_send_file',
    label: 'Send File to WeChat',
    description: '发送文件到微信。用于将 AI 产出的代码、报告等文件直接发给微信用户。',
    promptSnippet: '发送项目目录中的文件到微信',
    promptGuidelines: [
      '用户要求产出文件时，先写入文件再发送',
    ],
    parameters: Type.Object({
      filePath: Type.String({ description: '要发送的文件路径（项目目录内的绝对路径或相对路径）' }),
      fileName: Type.Optional(Type.String({ description: '在微信中显示的文件名（可选，默认使用原文件名）' })),
    }),
    async execute(_toolCallId, params, _signal) {
      if (currentState !== WechatState.WECHAT_CONNECTED || !socketClient || !lastWechatUser) {
        return { content: [{ type: 'text', text: '微信未连接或没有用户' }], details: {} };
      }
      
      // 解析路径
      const { resolve, isAbsolute } = await import('node:path');
      const { existsSync, statSync } = await import('node:fs');
      const cwd = process.cwd();
      const resolvedPath = isAbsolute(params.filePath) ? params.filePath : resolve(cwd, params.filePath);
      
      if (!existsSync(resolvedPath)) {
        return { content: [{ type: 'text', text: `文件不存在: ${params.filePath}` }], details: {} };
      }
      
      try {
        const stats = statSync(resolvedPath);
        await socketClient.request('wechat_send_file', {
          userId: lastWechatUser,
          filePath: resolvedPath,
          fileName: params.fileName,
        });
        const name = params.fileName || resolvedPath.split('/').pop();
        return { content: [{ type: 'text', text: `✅ 文件「${name}」(${(stats.size / 1024).toFixed(1)} KB) 已发送到微信` }], details: {} };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `发送失败: ${e.message}` }], details: {} };
      }
    },
  });
  
  pi.registerTool({
    name: 'wechat_send_image',
    label: 'Send Image to WeChat',
    description: '发送图片到微信。用于将 AI 生成的图表、截图等直接发给微信用户（支持预览）。',
    promptSnippet: '发送项目目录中的图片到微信（可预览）',
    promptGuidelines: [
      '用户要求生成图表/截图/图片时，先生成图片文件再发送',
    ],
    parameters: Type.Object({
      imagePath: Type.String({ description: '要发送的图片路径（项目目录内的绝对路径或相对路径，支持 png/jpg/gif/webp）' }),
    }),
    async execute(_toolCallId, params, _signal) {
      if (currentState !== WechatState.WECHAT_CONNECTED || !socketClient || !lastWechatUser) {
        return { content: [{ type: 'text', text: '微信未连接或没有用户' }], details: {} };
      }
      
      // 解析路径
      const { resolve, isAbsolute } = await import('node:path');
      const { existsSync, statSync } = await import('node:fs');
      const cwd = process.cwd();
      const resolvedPath = isAbsolute(params.imagePath) ? params.imagePath : resolve(cwd, params.imagePath);
      
      if (!existsSync(resolvedPath)) {
        return { content: [{ type: 'text', text: `图片不存在: ${params.imagePath}` }], details: {} };
      }
      
      try {
        const stats = statSync(resolvedPath);
        await socketClient.request('wechat_send_image', {
          userId: lastWechatUser,
          filePath: resolvedPath,
        });
        return { content: [{ type: 'text', text: `✅ 图片 (${(stats.size / 1024).toFixed(1)} KB) 已发送到微信` }], details: {} };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `发送失败: ${e.message}` }], details: {} };
      }
    },
  });
  
  // ===== wechat_notify_progress 工具（任务进度通知） =====
  pi.registerTool({
    name: 'wechat_notify_progress',
    label: 'Notify Progress to WeChat',
    description: '通知用户任务进度。仅在长任务的关键节点使用（调研完成、分析完成、代码生成等）。短任务不要使用。',
    promptSnippet: '通知微信用户任务进度（长任务时使用）',
    promptGuidelines: [
      '在关键节点调用：调研完成、分析完成、代码生成、遇到问题等',
      '消息会带 session 名称和已运行时间',
    ],
    parameters: Type.Object({
      message: Type.String({ description: '进度描述，如：调研完成，正在分析...' }),
    }),
    async execute(_toolCallId, params, _signal) {
      if (currentState !== WechatState.WECHAT_CONNECTED || !socketClient || !lastWechatUser) {
        return { content: [{ type: 'text', text: '微信未连接或没有用户' }], details: {} };
      }
      
      // 计算已运行时间
      const runtime = taskStartTime ? Math.floor((Date.now() - taskStartTime) / 1000) : 0;
      const runtimeText = runtime > 60 ? `${Math.floor(runtime / 60)} 分钟` : `${runtime} 秒`;
      
      // 获取 session 显示名
      const displayName = sessionName || sessionId.slice(0, 8);
      
      // 构造消息
      const text = `⏳ @${displayName}: ${params.message}（已运行 ${runtimeText}）`;
      
      // 记录进度消息到本地
      progressMessages.push(params.message);
      
      // 记录进度消息到守护进程
      try {
        await socketClient.request('add_progress', { sessionId, message: params.message });
      } catch {}
      
      try {
        await socketClient.request('send_to_wechat', { userId: lastWechatUser, text });
        return { content: [{ type: 'text', text: '✅ 进度已通知微信' }], details: {} };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `通知失败: ${e.message}` }], details: {} };
      }
    },
  });
  
  // ===== wechat_screenshot 工具（截屏并发送到微信） =====
  pi.registerTool({
    name: 'wechat_screenshot',
    label: 'Screenshot to WeChat',
    description: '根据自然语言描述截屏并发送到微信。可以截桌面、窗口、网页等。',
    promptSnippet: '截屏并发送到微信',
    promptGuidelines: [
      '直接描述你想看什么，比如：截屏看看桌面、截屏看看百度',
      '网页场景可以描述操作步骤，比如：打开百度搜AI然后截屏',
      '只能发送到微信，不能保存到本地',
    ],
    parameters: Type.Object({
      instruction: Type.String({ description: '自然语言描述，如：截屏看看桌面、截屏看看百度、打开百度搜AI然后截屏' }),
    }),
    async execute(_toolCallId, params, _signal) {
      if (currentState !== WechatState.WECHAT_CONNECTED || !socketClient || !lastWechatUser) {
        return { content: [{ type: 'text', text: '微信未连接或没有用户' }], details: {} };
      }
      
      const instruction = params.instruction;
      
      try {
        // 判断是桌面截屏还是网页截屏
        const isDesktop = instruction.includes('桌面') || instruction.includes('屏幕') || instruction.includes('窗口');
        
        let screenshotPath = '/tmp/wechat_screenshot.png';
        
        if (isDesktop) {
          // 桌面截屏：使用系统命令
          const { execSync } = await import('node:child_process');
          execSync(`screencapture -x ${screenshotPath}`);
        } else {
          // 网页截屏：使用 npx playwright
          const { execSync } = await import('node:child_process');
          const url = extractUrl(instruction) || 'https://www.baidu.com';
          execSync(`npx playwright screenshot ${url} ${screenshotPath} --browser chromium`, { timeout: 30000 });
        }
        
        // 发送图片到微信
        await socketClient.request('wechat_send_image', {
          userId: lastWechatUser,
          filePath: screenshotPath,
        });
        
        return { content: [{ type: 'text', text: '✅ 截图已发送到微信' }], details: {} };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `截屏失败: ${e.message}` }], details: {} };
      }
    },
  });
  
  // ===== wechat_cron 工具（定时任务管理） =====
  pi.registerTool({
    name: 'wechat_cron',
    label: 'Manage Cron Tasks',
    description: '管理微信定时任务。可以创建、列出、删除定时任务。',
    promptSnippet: '管理微信定时任务',
    promptGuidelines: [
      '创建定时任务时，和用户确认后再创建',
      '支持自然语言时间描述，如：每天早上9点、每30分钟',
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal('create'), Type.Literal('list'), Type.Literal('remove')]),
      schedule: Type.Optional(Type.String({ description: '自然语言时间描述，如：每天早上9点、每30分钟' })),
      task: Type.Optional(Type.String({ description: '任务描述' })),
      taskId: Type.Optional(Type.String({ description: '任务ID（删除时使用）' })),
    }),
    async execute(_toolCallId, params, _signal) {
      // 检查连接，如果未连接则尝试重连
      if (!socketClient?.connected) {
        const connected = await connectToDaemon();
        if (!connected || !socketClient?.connected) {
          return { content: [{ type: 'text', text: '微信未连接，请先执行 /wechat start' }], details: {} };
        }
      }
      
      // 更新微信状态到文件
      try {
        const status = await socketClient!.request('get_status', {}) as any;
        if (status.wechat?.connected) {
          updateWechatStatus({ loggedIn: true, connected: true, running: true });
        }
      } catch {}
      
      try {
        const result = await socketClient.request('cron_manage', {
          action: params.action,
          schedule: params.schedule,
          task: params.task,
          taskId: params.taskId,
          sessionId,
        });
        
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: {} };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `操作失败: ${e.message}` }], details: {} };
      }
    },
  });
  
  // ===== pi 退出 =====
  pi.on('session_shutdown', async (_event, ctx) => {
    cancelLogin(ctx);
    
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    
    if (socketClient) {
      try {
        await socketClient.request('unregister', { sessionId });
      } catch {}
      socketClient.close();
      socketClient = null;
    }
    
    currentState = WechatState.IDLE;
  });
}
