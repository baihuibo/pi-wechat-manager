// ============================================================================
// 状态存储 - 文件统一管理
// ============================================================================

import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const HOME = homedir();
const MANAGER_DIR = join(HOME, '.pi', 'agent', 'pi-wechat-manager');
const STATE_FILE = join(MANAGER_DIR, 'state.json');

// 状态接口
export interface WechatManagerState {
  // 微信状态
  wechat: {
    loggedIn: boolean;
    connected: boolean;
    running: boolean;
    accountId?: string;
    userId?: string;
  };
  
  // 守护进程状态
  daemon: {
    pid?: number;
    persist: boolean;
    startedAt?: number;
  };
  
  // Session 状态
  session: {
    defaultSessionId?: string;
    activeSessionId?: string;
  };
  
  // 别名
  aliases: Record<string, string>;
  
  // 定时任务
  cronTasks: Array<{
    id: string;
    schedule: string;
    cron: string;
    task: string;
    sessionId: string;
    isOnce: boolean;
    status: string;
    createdAt: number;
    nextRun?: number;
    lastRun?: number;
  }>;
  
  // 更新时间
  updatedAt: number;
}

// 默认状态
const DEFAULT_STATE: WechatManagerState = {
  wechat: {
    loggedIn: false,
    connected: false,
    running: false,
  },
  daemon: {
    persist: false,
  },
  session: {},
  aliases: {},
  cronTasks: [],
  updatedAt: Date.now(),
};

// 确保目录存在
function ensureDir() {
  if (!existsSync(MANAGER_DIR)) {
    mkdirSync(MANAGER_DIR, { recursive: true });
  }
}

// 加载状态
export function loadState(): WechatManagerState {
  ensureDir();
  if (existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      return { ...DEFAULT_STATE, ...data };
    } catch {}
  }
  return { ...DEFAULT_STATE };
}

// 保存状态
export function saveState(state: Partial<WechatManagerState>) {
  ensureDir();
  const current = loadState();
  const merged = {
    ...current,
    ...state,
    updatedAt: Date.now(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2));
}

// 更新微信状态
export function updateWechatStatus(status: Partial<WechatManagerState['wechat']>) {
  const state = loadState();
  saveState({
    wechat: { ...state.wechat, ...status },
  });
}

// 更新守护进程状态
export function updateDaemonStatus(status: Partial<WechatManagerState['daemon']>) {
  const state = loadState();
  saveState({
    daemon: { ...state.daemon, ...status },
  });
}

// 更新 session 状态
export function updateSessionStatus(status: Partial<WechatManagerState['session']>) {
  const state = loadState();
  saveState({
    session: { ...state.session, ...status },
  });
}

// 更新别名
export function updateAliases(aliases: Record<string, string>) {
  saveState({ aliases });
}

// 添加别名
export function addAlias(name: string, sessionId: string) {
  const state = loadState();
  const aliases = { ...state.aliases, [name]: sessionId };
  saveState({ aliases });
}

// 删除别名
export function removeAlias(name: string) {
  const state = loadState();
  const aliases = { ...state.aliases };
  delete aliases[name];
  saveState({ aliases });
}

// 获取别名
export function getAliases(): Record<string, string> {
  return loadState().aliases;
}

// 更新定时任务
export function updateCronTasks(cronTasks: WechatManagerState['cronTasks']) {
  saveState({ cronTasks });
}

// 添加定时任务
export function addCronTask(task: WechatManagerState['cronTasks'][0]) {
  const state = loadState();
  const cronTasks = [...state.cronTasks, task];
  saveState({ cronTasks });
}

// 删除定时任务
export function removeCronTask(taskId: string) {
  const state = loadState();
  const cronTasks = state.cronTasks.filter(t => t.id !== taskId);
  saveState({ cronTasks });
}

// 更新定时任务状态
export function updateCronTaskStatus(taskId: string, status: string, lastRun?: number) {
  const state = loadState();
  const cronTasks = state.cronTasks.map(t => {
    if (t.id === taskId) {
      return { ...t, status, lastRun: lastRun || t.lastRun };
    }
    return t;
  });
  saveState({ cronTasks });
}

// 获取定时任务
export function getCronTasks() {
  return loadState().cronTasks;
}

// 重置状态
export function resetState() {
  saveState(DEFAULT_STATE);
}
