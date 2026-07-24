// ============================================================================
// 守护进程状态管理
// ============================================================================

import { Socket } from 'node:net';

// 连接信息
export interface Connection {
  sessionId: string;
  pid: number;
  cwd: string;
  socket: Socket;
  lastHeartbeat: Date;
  connectedAt: Date;
  taskStartTime?: number;      // 任务开始时间
  progressMessages: string[];  // 进度消息历史
}

// 微信状态
export interface WechatStatus {
  loggedIn: boolean;
  accountId?: string;
  userId?: string;
  connected: boolean;
  running: boolean;
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
  
  // 最近断开连接的 session（用于区分重连和新连接）
  recentlyDisconnected: Set<string> = new Set();
  
  // /new 超时定时器: key=sessionName, value=timeout handle
  pendingNewTimers: Map<string, NodeJS.Timeout> = new Map();
  
  // 定时任务列表
  cronTasks: Map<string, CronTask> = new Map();
  
  // 注册连接
  register(sessionId: string, pid: number, cwd: string, socket: Socket): void {
    this.connections.set(sessionId, {
      sessionId,
      pid,
      cwd,
      socket,
      lastHeartbeat: new Date(),
      connectedAt: new Date(),
      progressMessages: [],
    });
    
    // 如果没有默认 session，设为第一个连接的
    if (!this.defaultSessionId) {
      this.defaultSessionId = sessionId;
    }
    
    console.log(`[状态] 注册 session: ${sessionId} (PID: ${pid})`);
  }
  
  // 注销连接
  unregister(sessionId: string): void {
    this.connections.delete(sessionId);
    this.recentlyDisconnected.add(sessionId);
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
  getProgress(sessionId: string): { startTime?: number; messages: string[] } {
    const conn = this.connections.get(sessionId);
    if (!conn) {
      return { messages: [] };
    }
    return {
      startTime: conn.taskStartTime,
      messages: [...conn.progressMessages],
    };
  }
  
  // 清除任务进度
  clearProgress(sessionId: string): void {
    const conn = this.connections.get(sessionId);
    if (conn) {
      conn.taskStartTime = undefined;
      conn.progressMessages = [];
    }
  }
  
  // 设置持久模式
  // 添加消息到队列
  enqueueMessage(sessionId: string, message: QueuedMessage): void {
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
  
  // 获取并移除队列中的消息
  dequeueMessages(sessionId: string): QueuedMessage[] {
    const messages = this.messageQueue.get(sessionId) || [];
    this.messageQueue.set(sessionId, []);
    return messages;
  }
  
  // 获取状态摘要
  getStatus(): any {
    return {
      wechat: this.wechat,
      connections: Array.from(this.connections.values()).map(c => ({
        sessionId: c.sessionId,
        pid: c.pid,
        cwd: c.cwd,
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
      }
    }
    
    for (const id of stale) {
      console.log(`[状态] Session ${id} 心跳超时，断开连接`);
      this.unregister(id);
    }
    
    // 定期清理 recentlyDisconnected（保留 60s）
    this.recentlyDisconnected.clear();
    
    return stale;
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
