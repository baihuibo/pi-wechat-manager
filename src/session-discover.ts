// ============================================================================
// Session 发现与状态读取
// ============================================================================

import { join } from 'node:path';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const SESSIONS_DIR = join(homedir(), '.pi', 'agent', 'sessions');

// Session 信息接口
export interface SessionInfo {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  lastMessage?: string;
  messageCount: number;
  isActive: boolean; // 有 pi 进程连接
}

// 解析 session 文件的 header
function parseSessionHeader(filePath: string): any | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    
    for (const line of lines.slice(0, 10)) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'session') {
          return obj;
        }
      } catch {}
    }
  } catch {}
  return null;
}

// 获取最后一条用户消息
function getLastUserMessage(filePath: string): string | undefined {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    
    // 从后往前找最后一条用户消息
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'message' && obj.message?.role === 'user') {
          const content = obj.message.content;
          if (typeof content === 'string') {
            return content.slice(0, 100);
          }
          if (Array.isArray(content)) {
            const textBlock = content.find((c: any) => c.type === 'text');
            if (textBlock?.text) {
              return textBlock.text.slice(0, 100);
            }
          }
        }
      } catch {}
    }
  } catch {}
  return undefined;
}

// 统计消息数量
function countMessages(filePath: string): number {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    let count = 0;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'message') count++;
      } catch {}
    }
    return count;
  } catch {
    return 0;
  }
}

// 获取 session 名称（从 session_info 条目）
function getSessionName(filePath: string): string | undefined {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'session_info' && obj.name) {
          return obj.name;
        }
      } catch {}
    }
  } catch {}
  return undefined;
}

// 列出所有 sessions
export function listSessions(): SessionInfo[] {
  if (!existsSync(SESSIONS_DIR)) {
    return [];
  }
  
  const sessions: SessionInfo[] = [];
  
  try {
    const dirs = readdirSync(SESSIONS_DIR);
    
    for (const dir of dirs) {
      const dirPath = join(SESSIONS_DIR, dir);
      try {
        const stat = statSync(dirPath);
        if (!stat.isDirectory()) continue;
        
        const files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        
        for (const file of files) {
          const filePath = join(dirPath, file);
          const header = parseSessionHeader(filePath);
          
          if (header) {
            const fileStat = statSync(filePath);
            sessions.push({
              id: header.id || file.replace('.jsonl', ''),
              path: filePath,
              cwd: header.cwd || '',
              name: getSessionName(filePath) || header.name,
              created: new Date(header.timestamp || fileStat.birthtime),
              modified: fileStat.mtime,
              lastMessage: getLastUserMessage(filePath),
              messageCount: countMessages(filePath),
              isActive: false, // 需要通过 daemon 状态更新
            });
          }
        }
      } catch {}
    }
  } catch {}
  
  // 按修改时间倒序
  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  
  return sessions;
}

// 获取单个 session 信息
export function getSession(sessionId: string): SessionInfo | null {
  const sessions = listSessions();
  return sessions.find(s => s.id === sessionId) || null;
}

// 获取最近的 session
export function getLatestSession(): SessionInfo | null {
  const sessions = listSessions();
  return sessions[0] || null;
}
