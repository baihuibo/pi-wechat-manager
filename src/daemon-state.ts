// ============================================================================
// 守护进程状态管理
// ============================================================================

import { Socket } from 'node:net';

// 连接信息
export interface Connection {
  sessionId: string;
  pid: number;
  cwd: string;
  name?: string;               // pi --name 指定的名字
  socket: Socket;
  lastHeartbeat: Date;
  connectedAt: Date;
  taskStartTime?: number;      // 任务开始时间
  progressMessages: string[];  // 进度消息历史
  lastTask?: string;           // 最近一次任务描述（用户消息）
}

// 微信状态
export interface WechatStatus {
  loggedIn: boolean;
  accountId?: string;
  userId?: string;
  connected: boolean;
  running: boolean;
}

// 启动追踪
export interface StartupAttempt {
  sessionId: string;
  userId: string;
  stage: 'starting' | 'launching_terminal' | 'waiting_connect' | 'timed_out' | 'failed';
  startedAt: number;
  lastFeedbackAt: number;
}

// 消息队列项
export interface QueuedMessage {
  id: string;
  sessionId: string;
  userId: string;
  text?: string;
  images?: string[];
  files?: string[];
  timestamp: number;
  retries: number;
  expiresAt: number;
}

// PendingSession 状态
export type PendingSessionStatus = 'pending' | 'connected' | 'inactive' | 'timeout' | 'killed';

// PendingSession - /new 创建后追踪的线程生命周期
export interface PendingSession {
  alias: string;              // 用户指定或自动生成，主键
  sessionId: string;          // pi --session-id 的值
  projectPath: string;        // 工作目录
  status: PendingSessionStatus;
  createdAt: number;
  createdBy: string;          // userId
  initialMessage?: string;    // 创建时的初始消息
  piPid?: number;             // pi 进程 pid（连接后才有）
  terminalPid?: number;       // 终端窗口 pid（如果能拿到）
  lastNotifyAt?: number;      // 上次通知用户超时的时间
}

// 定时任务
export interface CronTask {
  id: string;
  schedule: string;       // 原始自然语言
  cron: string;           // 转换后的 cron 表达式
  task: string;           // 任务描述
  sessionId: string;      // 执行的 session
  isOnce: boolean;        // 是否是单次任务
  status: 'pending' | 'confirmed' | 'running' | 'completed' | 'failed';
  createdAt: number;
  lastRun?: number;
  nextRun?: number;
  lastResult?: string;
}

// 守护进程状态
export class DaemonState {
  // 连接的 pi 实例
  connections: Map<string, Connection> = new Map();
  
  // 微信状态
  wechat: WechatStatus = {
    loggedIn: false,
    connected: false,
    running: false,
  };
  
  // 消息队列 (sessionId -> messages)
  messageQueue: Map<string, QueuedMessage[]> = new Map();
  
  // 默认 session（用于未指定 session 的消息）
  defaultSessionId: string | null = null;
  
  // 标记是否有新 session 即将创建（通过 /new 命令）
  pendingNewSession: boolean = false;
  
  // /new 命令的待投递消息，key=sessionName，value=队列消息（FIFO）
  pendingNewMessages: Map<string, QueuedMessage[]> = new Map();
  
  // /new 超时定时器: key=sessionName, value=timeout handle
  pendingNewTimers: Map<string, NodeJS.Timeout> = new Map();
  
  // Session 注册表：见过一次的 sessionId 永久标记（持久化到 JSON）
  sessionRegistry: Set<string> = new Set();
  
  // 启动追踪表（sessionId → 启动尝试）
  startupTracker: Map<string, StartupAttempt> = new Map();
  
  // 定时任务列表
  cronTasks: Map<string, CronTask> = new Map();
  
  // Pending Sessions（/new 创建的线程生命周期管理）
  pendingSessions: Map<string, PendingSession> = new Map();  // key = alias
  
  // 注册连接
  register(sessionId: string, pid: number, cwd: string, socket: Socket, name?: string): void {
    this.connections.set(sessionId, {
      sessionId,
      pid,
      cwd,
      name,
      socket,
      lastHeartbeat: new Date(),
      connectedAt: new Date(),
      progressMessages: [],
    });
    
    // 加入永久注册表（之后重连不视为新 pi）
    this.sessionRegistry.add(sessionId);
    
    // 如果没有默认 session，设为第一个连接的
    if (!this.defaultSessionId) {
      this.defaultSessionId = sessionId;
    }
    
    console.log(`[状态] 注册 session: ${sessionId} (PID: ${pid})`);
  }
  
  // 注销连接（不删注册表，sessionId 永久标记为「见过」）
  unregister(sessionId: string): void {
    this.connections.delete(sessionId);
    console.log(`[状态] 注销 session: ${sessionId}`);
    
    if (this.defaultSessionId === sessionId) {
      const remaining = Array.from(this.connections.keys());
      this.defaultSessionId = remaining[0] || null;
    }
  }
  
  // 更新心跳
  heartbeat(sessionId: string): boolean {
    const conn = this.connections.get(sessionId);
    if (conn) {
      conn.lastHeartbeat = new Date();
      return true;
    }
    return false;
  }
  
  // 设置任务开始时间
  setTaskStartTime(sessionId: string, startTime: number): void {
    const conn = this.connections.get(sessionId);
    if (conn) {
      conn.taskStartTime = startTime;
      conn.progressMessages = [];
    }
  }
  
  // 添加进度消息
  addProgressMessage(sessionId: string, message: string): void {
    const conn = this.connections.get(sessionId);
    if (conn) {
      conn.progressMessages.push(message);
      // 限制消息数量
      while (conn.progressMessages.length > 20) {
        conn.progressMessages.shift();
      }
    }
  }
  
  // 获取进度信息
  getProgress(sessionId: string): { startTime?: number; messages: string[]; lastTask?: string } {
    const conn = this.connections.get(sessionId);
    if (!conn) {
      return { messages: [] };
    }
    return {
      startTime: conn.taskStartTime,
      messages: [...conn.progressMessages],
      lastTask: conn.lastTask,
    };
  }

  // 设置最近任务
  setLastTask(sessionId: string, task: string): void {
    const conn = this.connections.get(sessionId);
    if (conn) conn.lastTask = task;
  }
  
  // 清除任务进度
  clearProgress(sessionId: string): void {
    const conn = this.connections.get(sessionId);
    if (conn) {
      conn.taskStartTime = undefined;
      conn.progressMessages = [];
    }
  }
  
  // ===== 启动追踪 =====
  isStartupPending(sessionId: string): boolean {
    const attempt = this.startupTracker.get(sessionId);
    if (!attempt) return false;
    // 超过 60s 的旧记录视为过期
    if (Date.now() - attempt.startedAt > 60000) {
      this.startupTracker.delete(sessionId);
      return false;
    }
    return attempt.stage !== 'timed_out' && attempt.stage !== 'failed';
  }
  
  hasStartupFailed(sessionId: string): boolean {
    const attempt = this.startupTracker.get(sessionId);
    if (!attempt) return false;
    return attempt.stage === 'timed_out' || attempt.stage === 'failed';
  }
  
  setStartup(sessionId: string, userId: string): void {
    this.startupTracker.set(sessionId, {
      sessionId, userId,
      stage: 'starting',
      startedAt: Date.now(),
      lastFeedbackAt: Date.now(),
    });
  }
  
  updateStartupStage(sessionId: string, stage: StartupAttempt['stage']): void {
    const attempt = this.startupTracker.get(sessionId);
    if (attempt) {
      attempt.stage = stage;
      attempt.lastFeedbackAt = Date.now();
    }
  }
  
  clearStartup(sessionId: string): void {
    this.startupTracker.delete(sessionId);
  }
  
  // ===== 消息队列 =====
  // 添加消息到队列（自动设置 2 分钟 TTL）
  enqueueMessage(sessionId: string, message: QueuedMessage): void {
    message.expiresAt = Date.now() + 120_000;
    if (!this.messageQueue.has(sessionId)) {
      this.messageQueue.set(sessionId, []);
    }
    const queue = this.messageQueue.get(sessionId)!;
    queue.push(message);
    
    // 限制队列大小
    while (queue.length > 1000) {
      queue.shift();
    }
  }
  
  // 获取并移除队列中的消息（过滤过期消息）
  dequeueMessages(sessionId: string): QueuedMessage[] {
    const all = this.messageQueue.get(sessionId) || [];
    this.messageQueue.set(sessionId, []);
    
    const now = Date.now();
    const expired = all.filter(m => m.expiresAt <= now);
    if (expired.length > 0) {
      console.log(`[队列] ${sessionId.slice(0,8)}: 丢弃 ${expired.length} 条过期消息`);
    }
    
    return all.filter(m => m.expiresAt > now);
  }
  
  // 清理所有队列中的过期消息（定时调用）
  cleanupExpiredMessages(): number {
    let total = 0;
    for (const [sessionId, queue] of this.messageQueue.entries()) {
      const before = queue.length;
      const now = Date.now();
      const valid = queue.filter(m => m.expiresAt > now);
      if (valid.length < before) {
        this.messageQueue.set(sessionId, valid);
        total += before - valid.length;
      }
    }
    if (total > 0) {
      console.log(`[队列] 清理了 ${total} 条全局过期消息`);
    }
    return total;
  }
  
  // 获取状态摘要
  getStatus(): any {
    return {
      wechat: this.wechat,
      connections: Array.from(this.connections.values()).map(c => ({
        sessionId: c.sessionId,
        pid: c.pid,
        cwd: c.cwd,
        name: c.name,
        lastHeartbeat: c.lastHeartbeat.toISOString(),
        connectedAt: c.connectedAt.toISOString(),
      })),
      defaultSessionId: this.defaultSessionId,
      queueSizes: Object.fromEntries(
        Array.from(this.messageQueue.entries()).map(([k, v]) => [k, v.length])
      ),
      cronTasks: Array.from(this.cronTasks.values()),
    };
  }
  
  // 管理定时任务
  manageCronTask(action: string, params: any): any {
    switch (action) {
      case 'create': {
        const id = `cron_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const { cron, isOnce, delayMs } = this.parseNaturalLanguageToCron(params.schedule);
        const nextRun = this.calculateNextRun(params.schedule);
        const task: CronTask = {
          id,
          schedule: params.schedule,
          cron,
          task: params.task,
          sessionId: params.sessionId,
          isOnce,
          status: 'confirmed',
          createdAt: Date.now(),
          nextRun,
        };
        this.cronTasks.set(id, task);
        console.log(`[定时任务] 创建任务: ${id} - ${params.task} (${isOnce ? '单次' : '循环'}, 下次执行: ${new Date(nextRun).toLocaleTimeString()})`);
        return { ok: true, task };
      }
      case 'list': {
        return { ok: true, tasks: Array.from(this.cronTasks.values()) };
      }
      case 'remove': {
        if (!params.taskId) {
          return { ok: false, error: '缺少 taskId' };
        }
        if (this.cronTasks.has(params.taskId)) {
          this.cronTasks.delete(params.taskId);
          console.log(`[定时任务] 删除任务: ${params.taskId}`);
          return { ok: true };
        }
        return { ok: false, error: '任务不存在' };
      }
      default:
        return { ok: false, error: `未知操作: ${action}` };
    }
  }
  
  // 获取所有定时任务
  getCronTasks(): CronTask[] {
    return Array.from(this.cronTasks.values());
  }
  
  // 解析自然语言到 cron 表达式
  private parseNaturalLanguageToCron(schedule: string): { cron: string; isOnce: boolean; delayMs?: number } {
    const s = schedule.toLowerCase();
    const now = Date.now();
    
    // 秒级延迟
    const secondsMatch = s.match(/(\d+)\s*秒后/);
    if (secondsMatch) {
      const seconds = parseInt(secondsMatch[1]);
      return { cron: '', isOnce: true, delayMs: seconds * 1000 };
    }
    
    // 分钟级延迟
    const minutesMatch = s.match(/(\d+)\s*分钟后/);
    if (minutesMatch) {
      const minutes = parseInt(minutesMatch[1]);
      return { cron: '', isOnce: true, delayMs: minutes * 60 * 1000 };
    }
    
    // 小时级延迟
    const hoursMatch = s.match(/(\d+)\s*小时后/);
    if (hoursMatch) {
      const hours = parseInt(hoursMatch[1]);
      return { cron: '', isOnce: true, delayMs: hours * 60 * 60 * 1000 };
    }
    
    // 明天X点
    const tomorrowMatch = s.match(/明天(\d+)点/);
    if (tomorrowMatch) {
      const hour = parseInt(tomorrowMatch[1]);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(hour, 0, 0, 0);
      return { cron: '', isOnce: true, delayMs: tomorrow.getTime() - now };
    }
    
    // 今天X点
    const todayMatch = s.match(/今天(\d+)点/);
    if (todayMatch) {
      const hour = parseInt(todayMatch[1]);
      const today = new Date();
      today.setHours(hour, 0, 0, 0);
      if (today.getTime() <= now) {
        today.setDate(today.getDate() + 1);
      }
      return { cron: '', isOnce: true, delayMs: today.getTime() - now };
    }
    
    // X点（今天的）
    const hourMatch = s.match(/(\d+)点/);
    if (hourMatch) {
      const hour = parseInt(hourMatch[1]);
      const target = new Date();
      target.setHours(hour, 0, 0, 0);
      if (target.getTime() <= now) {
        target.setDate(target.getDate() + 1);
      }
      return { cron: '', isOnce: true, delayMs: target.getTime() - now };
    }
    
    // 每天X点
    const dailyMatch = s.match(/每天(\d+)点/);
    if (dailyMatch) {
      const hour = parseInt(dailyMatch[1]);
      return { cron: `0 ${hour} * * *`, isOnce: false };
    }
    
    // 每X分钟
    const everyMinutesMatch = s.match(/每(\d+)分钟/);
    if (everyMinutesMatch) {
      const minutes = parseInt(everyMinutesMatch[1]);
      return { cron: `*/${minutes} * * * *`, isOnce: false };
    }
    
    // 每小时
    if (s.includes('每小时') || s.includes('每1小时')) {
      return { cron: '0 * * * *', isOnce: false };
    }
    
    // 每周X
    const weekdayMap: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
    for (const [name, day] of Object.entries(weekdayMap)) {
      if (s.includes(`每周${name}`)) {
        return { cron: `0 9 * * ${day}`, isOnce: false };
      }
    }
    
    // 默认：立即执行一次
    return { cron: '', isOnce: true, delayMs: 0 };
  }
  
  // 计算下次执行时间
  private calculateNextRun(schedule: string): number {
    const { cron, isOnce, delayMs } = this.parseNaturalLanguageToCron(schedule);
    
    if (delayMs !== undefined) {
      return Date.now() + delayMs;
    }
    
    // 对于 cron 表达式，计算下一个匹配时间
    // 简单实现：返回当前时间 + 1分钟
    return Date.now() + 60000;
  }
  
  // 执行定时任务
  executeCronTask(taskId: string): CronTask | null {
    const task = this.cronTasks.get(taskId);
    if (!task) return null;
    
    // 更新任务状态
    task.lastRun = Date.now();
    task.status = 'running';
    
    // 如果是单次任务，执行后删除
    if (task.isOnce) {
      console.log(`[定时任务] 单次任务执行完成，删除: ${taskId}`);
      this.cronTasks.delete(taskId);
    } else {
      // 循环任务，更新下次执行时间
      task.nextRun = this.calculateNextRun(task.cron);
      task.status = 'confirmed';
    }
    
    return task;
  }
  
  // 重置微信状态
  resetWechatStatus(): void {
    this.wechat.loggedIn = false;
    this.wechat.connected = false;
    this.wechat.running = false;
    this.wechat.accountId = undefined;
    this.wechat.userId = undefined;
  }
  
  // 清理失效连接（心跳超时）
  cleanupStaleConnections(timeoutMs: number): string[] {
    const now = Date.now();
    const stale: string[] = [];
    
    for (const [id, conn] of this.connections) {
      if (now - conn.lastHeartbeat.getTime() > timeoutMs) {
        stale.push(id);
        // 杀掉卡死的 pi 进程，对应的 Ghostty 窗口也会自动关闭
        try { process.kill(conn.pid, 'SIGTERM'); } catch {}
      }
    }
    
    for (const id of stale) {
      console.log(`[状态] Session ${id} 心跳超时，已终止进程并断开连接`);
      this.unregister(id);
    }
    
    return stale;
  }
  
  // ===== Pending Sessions =====
  
  // 创建 PendingSession
  createPendingSession(params: {
    alias: string;
    sessionId: string;
    projectPath: string;
    createdBy: string;
    initialMessage?: string;
  }): PendingSession {
    // 如果同名已存在，先清理旧的
    const existing = this.pendingSessions.get(params.alias);
    if (existing) {
      this.killPendingSessionProcess(existing);
    }
    
    const ps: PendingSession = {
      alias: params.alias,
      sessionId: params.sessionId,
      projectPath: params.projectPath,
      status: 'pending',
      createdAt: Date.now(),
      createdBy: params.createdBy,
      initialMessage: params.initialMessage,
    };
    this.pendingSessions.set(params.alias, ps);
    console.log(`[Pending] 创建: alias=${params.alias}, sessionId=${params.sessionId.slice(0,8)}`);
    return ps;
  }
  
  // 通过 sessionId 查找 PendingSession
  findBySessionId(sessionId: string): PendingSession | undefined {
    for (const ps of this.pendingSessions.values()) {
      if (ps.sessionId === sessionId) return ps;
    }
    return undefined;
  }
  
  // 通过别名查找
  findByAlias(alias: string): PendingSession | undefined {
    return this.pendingSessions.get(alias);
  }
  
  // pi 连接时：通过 sessionId 或 name 匹配 PendingSession，标记为 connected
  // 返回匹配到的 PendingSession，并回填真实 sessionId
  matchAndConnect(sessionId: string, pid: number, name?: string): PendingSession | undefined {
    // 1. 先按 sessionId 精确匹配
    let ps = this.findBySessionId(sessionId);
    
    // 2. 再按 name（alias）匹配
    if (!ps && name) {
      ps = this.findByAlias(name);
    }
    
    if (ps) {
      // 回填真实 sessionId（可能和占位符不同）
      if (ps.sessionId !== sessionId) {
        console.log(`[Pending] ${ps.alias} sessionId 回填: ${ps.sessionId.slice(0,8)} → ${sessionId.slice(0,8)}`);
        // 迁移消息队列
        const oldQueue = this.messageQueue.get(ps.sessionId);
        if (oldQueue && oldQueue.length > 0) {
          const newQueue = this.messageQueue.get(sessionId) || [];
          this.messageQueue.set(sessionId, [...newQueue, ...oldQueue]);
          this.messageQueue.delete(ps.sessionId);
          console.log(`[Pending] 迁移 ${oldQueue.length} 条队列消息到新 sessionId`);
        }
        // 迁移 pendingNewMessages（legacy）
        const oldPending = this.pendingNewMessages.get(ps.sessionId);
        if (oldPending) {
          this.pendingNewMessages.set(sessionId, oldPending);
          this.pendingNewMessages.delete(ps.sessionId);
        }
        ps.sessionId = sessionId;
      }
      ps.status = 'connected';
      ps.piPid = pid;
      ps.lastNotifyAt = undefined;
      console.log(`[Pending] ${ps.alias} → connected (pid=${pid})`);
    }
    return ps;
  }
  
  // pi 连接时：标记为 connected（仅按 sessionId，用于向后兼容）
  markPendingConnected(sessionId: string, pid: number): PendingSession | undefined {
    const ps = this.findBySessionId(sessionId);
    if (ps) {
      ps.status = 'connected';
      ps.piPid = pid;
      ps.lastNotifyAt = undefined; // 清除超时通知标记
      console.log(`[Pending] ${ps.alias} → connected (pid=${pid})`);
    }
    return ps;
  }
  
  // pi 断开时：标记为 inactive（自然断开，可复活）
  markPendingInactive(sessionId: string): PendingSession | undefined {
    const ps = this.findBySessionId(sessionId);
    if (ps && ps.status !== 'killed') {
      ps.status = 'inactive';
      ps.piPid = undefined;
      console.log(`[Pending] ${ps.alias} → inactive`);
    }
    return ps;
  }
  
  // /kill 时：标记为 killed（终态，不接受连接、不自动启动）
  markPendingKilled(sessionId: string): PendingSession | undefined {
    const ps = this.findBySessionId(sessionId);
    if (ps) {
      ps.status = 'killed';
      ps.piPid = undefined;
      ps.lastNotifyAt = undefined;
      console.log(`[Pending] ${ps.alias} → killed`);
    }
    return ps;
  }
  
  // 超时：标记为 timeout
  markPendingTimeout(alias: string): PendingSession | undefined {
    const ps = this.pendingSessions.get(alias);
    if (ps && (ps.status === 'pending' || ps.status === 'inactive')) {
      ps.status = 'timeout';
      console.log(`[Pending] ${alias} → timeout`);
    }
    return ps;
  }
  
  // 杀掉 PendingSession 相关进程
  killPendingSessionProcess(ps: PendingSession): void {
    // 1. 杀 pi 进程
    if (ps.piPid) {
      try { process.kill(ps.piPid, 'SIGTERM'); } catch {}
    } else {
      // 没有 pid，通过 sessionId 查找
      try {
        const { execSync } = require('node:child_process');
        const output = execSync(`ps aux | grep "pi --session-id ${ps.sessionId}" | grep -v grep | awk '{print $2}'`, { encoding: 'utf-8', timeout: 3000 });
        const pids = output.trim().split('\n').filter(Boolean);
        for (const pid of pids) {
          try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
        }
      } catch {}
    }
    // 2. 清理可能残留的 pendingNewMessages
    this.pendingNewMessages.delete(ps.sessionId);
    const timer = this.pendingNewTimers.get(ps.sessionId);
    if (timer) { clearTimeout(timer); this.pendingNewTimers.delete(ps.sessionId); }
  }
  
  // 检查超时的 pending sessions，返回需要通知的列表
  checkTimeoutPendingSessions(now: number): PendingSession[] {
    const TIMEOUT_MS = 5 * 60 * 1000;  // 5 分钟
    const NOTIFY_INTERVAL = 10 * 60 * 1000;  // 10 分钟内不重复通知
    const needNotify: PendingSession[] = [];
    
    for (const ps of this.pendingSessions.values()) {
      if (ps.status === 'pending' || ps.status === 'inactive') {
        const elapsed = now - ps.createdAt;
        if (elapsed > TIMEOUT_MS) {
          // 标记为 timeout
          ps.status = 'timeout';
          // 检查是否需要通知（首次超时或距上次通知超过间隔）
          if (!ps.lastNotifyAt || (now - ps.lastNotifyAt > NOTIFY_INTERVAL)) {
            needNotify.push(ps);
            ps.lastNotifyAt = now;
          }
        }
      }
    }
    return needNotify;
  }
  
  // 获取所有 pending sessions（用于 /sessions 等）
  getPendingSessions(): PendingSession[] {
    return Array.from(this.pendingSessions.values());
  }
  
  // 序列化 pendingSessions 用于持久化
  serializePendingSessions(): any[] {
    return Array.from(this.pendingSessions.values()).map(ps => ({
      ...ps,
      // 不持久化 lastNotifyAt（重启后重新计时）
      lastNotifyAt: undefined,
    }));
  }
  
  // 从持久化数据恢复 pendingSessions
  restorePendingSessions(data: any[]): void {
    for (const item of data) {
      const ps: PendingSession = {
        alias: item.alias,
        sessionId: item.sessionId,
        projectPath: item.projectPath,
        status: item.status || 'pending',
        createdAt: item.createdAt || Date.now(),
        createdBy: item.createdBy || '',
        initialMessage: item.initialMessage,
        piPid: undefined,  // 重启后 pid 已无效
        terminalPid: undefined,
      };
      // 重启后检查进程是否还活着
      if (ps.status === 'connected' || ps.status === 'inactive') {
        try {
          const { execSync } = require('node:child_process');
          execSync(`ps aux | grep "pi --session-id ${ps.sessionId}" | grep -v grep`, { encoding: 'utf-8', timeout: 3000 });
          // 进程还在 → 保持 connected，等待重新 register
          ps.status = 'inactive';
        } catch {
          // 进程已死
          ps.status = 'inactive';
        }
      }
      this.pendingSessions.set(ps.alias, ps);
    }
    console.log(`[Pending] 从磁盘恢复 ${this.pendingSessions.size} 个 pending sessions`);
  }
  
  // 按名称查找 cron 任务
  findCronTaskByName(name: string): CronTask | null {
    for (const task of this.cronTasks.values()) {
      if (task.task.includes(name) || task.schedule.includes(name)) {
        return task;
      }
    }
    return null;
  }
  
  // 向特定 session 发送消息
  sendToSession(sessionId: string, event: string, data: any): boolean {
    const conn = this.connections.get(sessionId);
    if (conn?.socket.writable) {
      const msg = JSON.stringify({ event, data }) + '\n';
      conn.socket.write(msg);
      return true;
    }
    return false;
  }
  
  // 广播给所有连接的 pi
  broadcast(event: string, data: any): void {
    const msg = JSON.stringify({ event, data }) + '\n';
    for (const conn of this.connections.values()) {
      if (conn.socket.writable) {
        conn.socket.write(msg);
      }
    }
  }
}
