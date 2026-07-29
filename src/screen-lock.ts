// ============================================================================
// macOS 锁屏检测
// ============================================================================
// 依据 CGSessionCopyCurrentDictionary()["CGSSessionScreenIsLocked"]
// - 锁屏时该键为 true
// - 未锁屏时通常不存在该键
// 检测失败时返回 false（不误伤解锁场景的 GUI 路径）

import { execFileSync } from 'node:child_process';

let cache: { at: number; locked: boolean } | null = null;
const CACHE_MS = 2_000;

const SWIFT_SNIPPET = `
import CoreGraphics
import Foundation
let d = CGSessionCopyCurrentDictionary() as NSDictionary?
let locked = (d?["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue == true
print(locked ? "1" : "0")
`.trim();

/**
 * 当前控制台会话是否处于锁屏状态。
 * 非 macOS / 检测失败 → false。
 */
export function isScreenLocked(): boolean {
  if (process.platform !== 'darwin') return false;

  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) {
    return cache.locked;
  }

  let locked = false;
  try {
    const out = execFileSync('swift', ['-e', SWIFT_SNIPPET], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    locked = out.trim() === '1';
  } catch (e) {
    console.warn('[锁屏] 检测失败，按未锁屏处理:', e instanceof Error ? e.message : e);
    locked = false;
  }

  cache = { at: now, locked };
  return locked;
}

/** 测试/调试用：清空缓存 */
export function clearScreenLockCache(): void {
  cache = null;
}
