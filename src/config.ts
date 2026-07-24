// ============================================================================
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

// 路径常量
const HOME = homedir();
export const PI_DIR = join(HOME, '.pi', 'agent');
export const MANAGER_DIR = join(PI_DIR, 'pi-wechat-manager');
export const SOCKET_PATH = join(MANAGER_DIR, 'daemon.sock');
export const PID_FILE = join(MANAGER_DIR, 'daemon.pid');
export const LOG_FILE = join(MANAGER_DIR, 'daemon.log');
export const CREDENTIALS_FILE = join(MANAGER_DIR, 'credentials.json');
export const ALIASES_FILE = join(MANAGER_DIR, 'aliases.json');
export const QUEUE_DIR = join(MANAGER_DIR, 'queue');
export const MEDIA_DIR = join(MANAGER_DIR, 'media');
export const PLIST_PATH = join(HOME, 'Library', 'LaunchAgents', 'com.pi.wechat-manager.plist');
export const SESSION_REGISTRY_FILE = join(MANAGER_DIR, 'session-registry.json');
export const HTTP_PORT = 19087;

// 配置接口
export interface DaemonConfig {
  httpPort: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  autoSpawnPi: boolean;
  maxQueueSize: number;
  llmApiKey?: string;  // DeepSeek API Key
}

// 默认配置
const DEFAULT_CONFIG: DaemonConfig = {
  httpPort: HTTP_PORT,
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 60_000,
  autoSpawnPi: false,
  maxQueueSize: 1000,
};

// 配置文件路径
const CONFIG_FILE = join(MANAGER_DIR, 'config.json');

// 确保目录存在
export function ensureDirectories() {
  for (const dir of [MANAGER_DIR, QUEUE_DIR, MEDIA_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

// 加载配置
export function loadConfig(): DaemonConfig {
  ensureDirectories();
  if (existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      return { ...DEFAULT_CONFIG, ...data };
    } catch {}
  }
  return { ...DEFAULT_CONFIG };
}

// 保存配置
export function saveConfig(config: Partial<DaemonConfig>) {
  ensureDirectories();
  const current = loadConfig();
  const merged = { ...current, ...config };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
}

// 加载凭证
export function loadCredentials(): any | null {
  if (existsSync(CREDENTIALS_FILE)) {
    try {
      return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf-8'));
    } catch {}
  }
  return null;
}

// 保存凭证
export function saveCredentials(credentials: any) {
  ensureDirectories();
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
}

// 清除凭证
export function clearCredentials() {
  if (existsSync(CREDENTIALS_FILE)) {
    try {
      unlinkSync(CREDENTIALS_FILE);
    } catch {}
  }
}

// 加载别名
export function loadAliases(): Record<string, string> {
  if (existsSync(ALIASES_FILE)) {
    try {
      return JSON.parse(readFileSync(ALIASES_FILE, 'utf-8'));
    } catch {}
  }
  return {};
}

// 保存别名
export function saveAliases(aliases: Record<string, string>) {
  ensureDirectories();
  writeFileSync(ALIASES_FILE, JSON.stringify(aliases, null, 2));
}

// 加载 Session 注册表（sessionId 列表，持久化，永久有效）
export function loadSessionRegistry(): Set<string> {
  if (existsSync(SESSION_REGISTRY_FILE)) {
    try {
      const data = JSON.parse(readFileSync(SESSION_REGISTRY_FILE, 'utf-8'));
      return new Set(Array.isArray(data) ? data : []);
    } catch {}
  }
  return new Set();
}

// 保存 Session 注册表
export function saveSessionRegistry(registry: Set<string>) {
  ensureDirectories();
  writeFileSync(SESSION_REGISTRY_FILE, JSON.stringify([...registry], null, 2));
}
