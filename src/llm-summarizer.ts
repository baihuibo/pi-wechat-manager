// ============================================================================
// Session 摘要服务
// ============================================================================

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execAsync = promisify(exec);

// 读取 session 的最近消息
function getRecentMessages(sessionPath: string, count = 10): string {
  try {
    const content = readFileSync(sessionPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    
    const messages: string[] = [];
    
    // 从后往前读
    for (let i = lines.length - 1; i >= 0 && messages.length < count; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        
        if (obj.type === 'message' && obj.message) {
          const role = obj.message.role;
          let text = '';
          
          if (typeof obj.message.content === 'string') {
            text = obj.message.content;
          } else if (Array.isArray(obj.message.content)) {
            const textBlocks = obj.message.content.filter((c: any) => c.type === 'text');
            text = textBlocks.map((c: any) => c.text).join('\n');
          }
          
          if (text && (role === 'user' || role === 'assistant')) {
            const label = role === 'user' ? '用户' : 'AI';
            messages.unshift(`${label}：${text.slice(0, 150)}`);
          }
        }
      } catch {}
    }
    
    return messages.join('\n');
  } catch {
    return '';
  }
}

// 用 pi 摘要单个 session
export async function summarizeSession(sessionPath: string, sessionName?: string): Promise<string> {
  const conversation = getRecentMessages(sessionPath, 6);
  
  if (!conversation) {
    return sessionName || '空 session';
  }
  
  const prompt = `请用一句话（不超过30字）概括这个对话在做什么：

${conversation}

要求：只输出概括，例如"修复登录bug"、"开发新功能"`;
  
  // 写入临时文件，避免 shell 转义问题
  const tmpFile = join(tmpdir(), `pi-summary-${Date.now()}.txt`);
  
  try {
    writeFileSync(tmpFile, prompt, 'utf-8');
    
    // 使用文件输入，--no-session 不创建 session
    const { stdout } = await execAsync(
      `cat ${tmpFile} | pi --no-session --model deepseek/deepseek-v4-flash -p - 2>/dev/null`,
      { timeout: 15000 }
    );
    
    const summary = stdout.trim();
    return summary || simpleSummary(sessionPath, sessionName);
  } catch {
    // 静默失败，使用简单摘要
    return simpleSummary(sessionPath, sessionName);
  } finally {
    // 清理临时文件
    try { unlinkSync(tmpFile); } catch {}
  }
}

// 简单摘要（降级方案）
function simpleSummary(sessionPath: string, sessionName?: string): string {
  try {
    const content = readFileSync(sessionPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    
    // 找最后一条用户消息
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'message' && obj.message?.role === 'user') {
          let text = '';
          if (typeof obj.message.content === 'string') {
            text = obj.message.content;
          } else if (Array.isArray(obj.message.content)) {
            const textBlock = obj.message.content.find((c: any) => c.type === 'text');
            text = textBlock?.text || '';
          }
          
          if (text) {
            return text.slice(0, 30) + (text.length > 30 ? '...' : '');
          }
        }
      } catch {}
    }
    
    return sessionName || '无消息';
  } catch {
    return sessionName || '读取失败';
  }
}

// 批量摘要多个 sessions
export async function summarizeSessions(sessions: Array<{ path: string; name?: string }>): Promise<Map<string, string>> {
  const summaries = new Map<string, string>();
  
  // 并发摘要（限制并发数）
  const concurrency = 3;
  const chunks: typeof sessions[] = [];
  
  for (let i = 0; i < sessions.length; i += concurrency) {
    chunks.push(sessions.slice(i, i + concurrency));
  }
  
  for (const chunk of chunks) {
    const results = await Promise.all(
      chunk.map(async (s) => {
        const summary = await summarizeSession(s.path, s.name);
        return { path: s.path, summary };
      })
    );
    
    for (const { path, summary } of results) {
      summaries.set(path, summary);
    }
  }
  
  return summaries;
}
