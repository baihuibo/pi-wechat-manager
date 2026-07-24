// ============================================================================
// pi-wechat-manager 守护进程
// ============================================================================

import { createServer, Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonState } from './daemon-state.js';
import {
  SOCKET_PATH,
  PID_FILE,
  HTTP_PORT,
  ensureDirectories,
  loadConfig,
  loadCredentials,
  saveCredentials,
  loadAliases,
  saveAliases,
} from './config.js';
import { listSessions, getLatestSession } from './session-discover.js';
import { WechatBridge } from './wechat-bridge.js';

// ============================================================================
// 全局状态
// ============================================================================

const state = new DaemonState();
const wechatBridge = new WechatBridge(state);
let httpServer: ReturnType<typeof createHttpServer> | null = null;

// ============================================================================
// Socket 服务器（pi 扩展连接）
// ============================================================================

async function handleSocketMessage(socket: Socket, msg: any): Promise<void> {
  const { id, method, params } = msg;
  
  // 响应函数
  const respond = (result: any) => {
    if (id) {
      socket.write(JSON.stringify({ id, result }) + '\n');
    }
  };
  
  const respondError = (code: number, message: string) => {
    if (id) {
      socket.write(JSON.stringify({ id, error: { code, message } }) + '\n');
    }
  };
  
  switch (method) {
    case 'register': {
      const { sessionId, pid, cwd } = params;
      const isNew = !state.connections.has(sessionId);
      state.register(sessionId, pid, cwd, socket);
      
      // 如果是新连接的 pi，且是通过 /new 命令启动的
      if (isNew && state.pendingNewSession) {
        state.defaultSessionId = sessionId;
        console.log(`[状态] 新 pi 已连接，设置为默认 session: ${sessionId}`);
        
        // 取第一个待投递的消息批次（FIFO）
        const pendingEntries = Array.from(state.pendingNewMessages.entries());
        if (pendingEntries.length > 0) {
          const [key, messages] = pendingEntries[0];
          state.pendingNewMessages.delete(key);
          console.log(`[状态] 投递 ${messages.length} 条消息给 ${sessionId.slice(0,8)}（绑定名: ${key}）`);
          
          for (const msg of messages) {
            state.enqueueMessage(sessionId, { ...msg, sessionId });
          }
        }
        
        // 没有更多待投递消息时清除标记
        if (state.pendingNewMessages.size === 0) {
          state.pendingNewSession = false;
        }
      }
      
      // 投递队列中的消息
      const queued = state.dequeueMessages(sessionId);
      if (queued.length > 0) {
        for (const msg of queued) {
          state.sendToSession(sessionId, 'wechat_message', msg);
        }
      }
      
      respond({
        ok: true,
        wechat: state.wechat,
        defaultSessionId: state.defaultSessionId,
      });
      break;
    }
    
    case 'unregister': {
      state.unregister(params.sessionId);
      respond({ ok: true });
      break;
    }
    
    case 'heartbeat': {
      const ok = state.heartbeat(params.sessionId);
      respond({ ok });
      break;
    }
    
    case 'get_status': {
      respond(state.getStatus());
      break;
    }
    
    case 'get_wechat_status': {
      respond(wechatBridge.getStatus());
      break;
    }
    
    case 'wechat_login_success': {
      // 微信登录成功，重新初始化并开始轮询
      console.log('[微信] 收到登录成功通知，重新初始化...');
      try {
        await wechatBridge.init();
        await wechatBridge.startPolling();
        respond({ ok: true });
      } catch (e: any) {
        respond({ ok: false, error: e.message });
      }
      break;
    }
    
    case 'wechat_logout': {
      // 退出微信登录
      console.log('[微信] 收到退出登录通知');
      await wechatBridge.stopPolling();
      state.resetWechatStatus();
      // 清除凭证文件
      const { clearCredentials } = await import('./config.js');
      await clearCredentials();
      respond({ ok: true });
      break;
    }
    
    case 'wechat_login': {
      // TODO: 实现微信登录流程
      respond({ ok: false, error: '登录功能待实现' });
      break;
    }
    
    case 'wechat_send': {
      // 发送消息到微信
      const { userId, text } = params;
      try {
        await wechatBridge.sendText(userId, text);
        respond({ ok: true });
      } catch (e: any) {
        respond({ ok: false, error: e.message });
      }
      break;
    }
    
    case 'wechat_send_image': {
      // 发送图片到微信
      const { userId, filePath } = params;
      try {
        await wechatBridge.sendImage(userId, filePath);
        respond({ ok: true });
      } catch (e: any) {
        respond({ ok: false, error: e.message });
      }
      break;
    }
    
    case 'wechat_send_file': {
      // 发送文件到微信
      const { userId, filePath, fileName } = params;
      try {
        await wechatBridge.sendFile(userId, filePath, fileName);
        respond({ ok: true });
      } catch (e: any) {
        respond({ ok: false, error: e.message });
      }
      break;
    }
    
    case 'set_default_session': {
      state.defaultSessionId = params.sessionId;
      respond({ ok: true, defaultSessionId: state.defaultSessionId });
      break;
    }
    
    case 'send_to_wechat': {
      // 转发消息到微信
      const { userId, text } = params;
      try {
        await wechatBridge.sendText(userId, text);
        respond({ ok: true });
      } catch (e: any) {
        respond({ ok: false, error: e.message });
      }
      break;
    }
    
    case 'send_typing': {
      // 发送"正在输入"状态
      const { userId, status } = params;
      try {
        await wechatBridge.sendTyping(userId, status);
        respond({ ok: true });
      } catch (e: any) {
        respond({ ok: false, error: e.message });
      }
      break;
    }
    
    case 'send_file_to_wechat': {
      // 发送文件到微信
      const { userId, filePath, fileName } = params;
      try {
        await wechatBridge.sendFile(userId, filePath, fileName);
        respond({ ok: true });
      } catch (e: any) {
        respond({ ok: false, error: e.message });
      }
      break;
    }
    
    case 'send_image_to_wechat': {
      // 发送图片到微信
      const { userId, filePath } = params;
      try {
        await wechatBridge.sendImage(userId, filePath);
        respond({ ok: true });
      } catch (e: any) {
        respond({ ok: false, error: e.message });
      }
      break;
    }
    
    case 'report_message': {
      // pi 推送 agent 回复，转发到微信
      // TODO: 实现微信客户端发送
      console.log(`[消息] Session ${params.sessionId} 推送回复: ${params.content?.slice(0, 50)}...`);
      respond({ ok: true });
      break;
    }
    
    case 'report_status': {
      // pi 推送状态变化
      console.log(`[状态] Session ${params.sessionId}: ${params.status}`);
      respond({ ok: true });
      break;
    }
    
    case 'report_tool': {
      // pi 推送工具执行
      console.log(`[工具] Session ${params.sessionId}: ${params.toolName}`);
      respond({ ok: true });
      break;
    }
    
    case 'set_task_start': {
      // 设置任务开始时间
      const { sessionId, startTime } = params;
      state.setTaskStartTime(sessionId, startTime);
      respond({ ok: true });
      break;
    }
    
    case 'add_progress': {
      // 添加进度消息
      const { sessionId, message } = params;
      state.addProgressMessage(sessionId, message);
      respond({ ok: true });
      break;
    }
    
    case 'get_progress': {
      // 获取进度信息
      const { sessionId } = params;
      const progress = state.getProgress(sessionId);
      respond(progress);
      break;
    }
    
    case 'clear_progress': {
      // 清除任务进度
      const { sessionId } = params;
      state.clearProgress(sessionId);
      respond({ ok: true });
      break;
    }
    
    case 'cron_manage': {
      // 管理定时任务
      const { action, schedule, task, taskId, sessionId } = params;
      try {
        const result = state.manageCronTask(action, { schedule, task, taskId, sessionId });
        respond(result);
      } catch (e: any) {
        respondError(500, e.message);
      }
      break;
    }
    
    case 'get_cron_tasks': {
      // 获取所有定时任务
      respond(state.getCronTasks());
      break;
    }
    
    case 'forward_to_wechat': {
      // 转发命令到微信
      const { command, args, userId } = params;
      // 这个命令会被 wechat_bridge 处理
      respond({ ok: true });
      break;
    }
    
    case 'get_aliases': {
      respond(loadAliases());
      break;
    }
    
    case 'set_alias': {
      const aliases = loadAliases();
      aliases[params.name] = params.sessionId;
      saveAliases(aliases);
      respond({ ok: true });
      break;
    }
    
    case 'delete_alias': {
      const aliases = loadAliases();
      delete aliases[params.name];
      saveAliases(aliases);
      respond({ ok: true });
      break;
    }
    
    case 'get_sessions': {
      const sessions = listSessions();
      // 标记活跃 session
      for (const session of sessions) {
        session.isActive = state.connections.has(session.id);
      }
      respond(sessions);
      break;
    }
    
    case 'route_message': {
      // 路由消息到正确的 session
      const { userId, text, images, files } = params;
      const aliases = loadAliases();
      
      let targetSessionId = state.defaultSessionId;
      
      // 检查是否是 @别名 消息
      if (text?.startsWith('@')) {
        const spaceIndex = text.indexOf(' ');
        if (spaceIndex > 0) {
          const alias = text.slice(1, spaceIndex);
          const message = text.slice(spaceIndex + 1);
          if (aliases[alias]) {
            targetSessionId = aliases[alias];
          }
        }
      }
      
      if (!targetSessionId) {
        // 没有目标 session，尝试找最近的
        const latest = getLatestSession();
        if (latest) {
          targetSessionId = latest.id;
        } else {
          respondError(404, '没有可用的 session');
          return;
        }
      }
      
      // 检查目标 session 是否有 pi 在运行
      const conn = state.connections.get(targetSessionId);
      if (conn?.socket.writable) {
        // 直接推送
        state.sendToSession(targetSessionId, 'wechat_message', {
          userId,
          text,
          images,
          files,
          timestamp: Date.now(),
        });
      } else {
        // 入队
        state.enqueueMessage(targetSessionId, {
          id: `msg_${Date.now()}`,
          sessionId: targetSessionId,
          userId,
          text,
          images,
          files,
          timestamp: Date.now(),
          retries: 0,
        });
        // TODO: 可选自动 spawn pi
      }
      
      respond({ ok: true, targetSessionId });
      break;
    }
    
    default:
      respondError(404, `未知方法: ${method}`);
  }
}

function startSocketServer(): void {
  if (existsSync(SOCKET_PATH)) {
    unlinkSync(SOCKET_PATH);
  }
  
  const server = createServer((socket) => {
    let buffer = '';
    
    socket.on('data', (data) => {
      buffer += data.toString();
      
      // 处理完整的消息（以换行分隔）
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留未完成的行
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            handleSocketMessage(socket, msg);
          } catch (e) {
            console.error('[Socket] 解析消息失败:', e);
          }
        }
      }
    });
    
    socket.on('close', () => {
      // 找到并注销对应的 session
      for (const [id, conn] of state.connections) {
        if (conn.socket === socket) {
          state.unregister(id);
          break;
        }
      }
    });
    
    socket.on('error', (err) => {
      console.error('[Socket] 连接错误:', err.message);
    });
  });
  
  server.listen(SOCKET_PATH, () => {
    console.log(`[Socket] 服务器已启动: ${SOCKET_PATH}`);
  });
}

// ============================================================================
// HTTP 服务器（Web UI）
// ============================================================================

function startHttpServer(): void {
  httpServer = createHttpServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    
    const url = new URL(req.url || '/', `http://localhost:${HTTP_PORT}`);
    
    // API 路由
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      
      switch (url.pathname) {
        case '/api/status':
          res.end(JSON.stringify(state.getStatus()));
          return;
          
        case '/api/sessions': {
          const sessions = listSessions();
          for (const session of sessions) {
            session.isActive = state.connections.has(session.id);
          }
          res.end(JSON.stringify(sessions));
          return;
        }
          
        case '/api/aliases':
          res.end(JSON.stringify(loadAliases()));
          return;
          
        case '/api/wechat/status':
          res.end(JSON.stringify(state.wechat));
          return;
          
        default:
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
      }
    }
    
    // 根路径返回 API 说明
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        name: 'pi-wechat-manager',
        version: '1.0.0',
        endpoints: [
          '/api/status',
          '/api/sessions',
          '/api/aliases',
          '/api/wechat/status'
        ]
      }));
      return;
    }
    
    res.writeHead(404);
    res.end('Not found');
  });
  
  httpServer.listen(HTTP_PORT, () => {
    console.log(`[HTTP] API 服务器已启动: http://localhost:${HTTP_PORT}`);
  });
}

// ============================================================================
// 心跳检测
// ============================================================================

function startHeartbeatChecker(): void {
  const config = loadConfig();
  
  setInterval(() => {
    state.cleanupStaleConnections(config.heartbeatTimeoutMs);
  }, config.heartbeatIntervalMs);
}

// ============================================================================
// 定时任务调度器（高效版）
// ============================================================================

let cronTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNextCronTask(): void {
  // 清除之前的定时器
  if (cronTimer) {
    clearTimeout(cronTimer);
    cronTimer = null;
  }
  
  const tasks = state.getCronTasks();
  const now = Date.now();
  
  // 找到最近的到期任务
  let nextRun = Infinity;
  for (const task of tasks) {
    if (task.status !== 'confirmed' || !task.nextRun) continue;
    if (task.nextRun < nextRun) {
      nextRun = task.nextRun;
    }
  }
  
  // 如果没有任务，不调度
  if (nextRun === Infinity) return;
  
  // 计算延迟时间（至少 100ms，避免忙等）
  const delay = Math.max(100, nextRun - now);
  
  console.log(`[定时任务] 下次执行: ${new Date(nextRun).toLocaleTimeString()} (${Math.round(delay / 1000)}秒后)`);
  
  cronTimer = setTimeout(async () => {
    await executeDueCronTasks();
    scheduleNextCronTask(); // 调度下一个
  }, delay);
}

async function executeDueCronTasks(): Promise<void> {
  const now = Date.now();
  const tasks = state.getCronTasks();
  
  for (const task of tasks) {
    if (task.status !== 'confirmed' || !task.nextRun) continue;
    if (task.nextRun > now) continue;
    
    console.log(`[定时任务] 执行任务: ${task.id} - ${task.task}`);
    
    // 执行任务
    const executed = state.executeCronTask(task.id);
    if (!executed) continue;
    
    // 发送消息到微信
    try {
      const userId = state.wechat.userId;
      if (userId) {
        const displayName = task.sessionId.slice(0, 8);
        const message = `⏰ **定时任务 @${displayName}**\n\n${task.task}`;
        await wechatBridge.sendText(userId, message);
        console.log(`[定时任务] 任务执行完成: ${task.id}`);
      }
    } catch (e) {
      console.error(`[定时任务] 发送消息失败: ${task.id}`, e);
    }
  }
}

function startCronScheduler(): void {
  // 启动时调度一次
  scheduleNextCronTask();
  
  // 监听任务变化（通过轮询，但只在有任务时活跃）
  setInterval(() => {
    const tasks = state.getCronTasks();
    if (tasks.length > 0) {
      scheduleNextCronTask();
    }
  }, 60000); // 每分钟检查一次任务列表变化
}

// ============================================================================
// 启动/停止
// ============================================================================

function writePidFile(): void {
  writeFileSync(PID_FILE, process.pid.toString());
}

function cleanup(): void {
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}

async function start(): Promise<void> {
  console.log('====================================');
  console.log('pi-wechat-manager daemon starting...');
  console.log('====================================');
  
  ensureDirectories();
  writePidFile();
  
  // 启动服务器
  startSocketServer();
  startHttpServer();
  startHeartbeatChecker();
  startCronScheduler();
  
  // 初始化微信客户端
  state.resetWechatStatus(); // 先重置状态
  const hasCredentials = await wechatBridge.init();
  if (hasCredentials) {
    console.log('[微信] 凭证已加载，尝试开始轮询');
    try {
      await wechatBridge.startPolling();
    } catch (e) {
      console.error('[微信] 轮询启动失败:', e);
      state.resetWechatStatus();
    }
  } else {
    console.log('[微信] 没有凭证，需要先登录');
  }
  
  console.log('[守护进程] 已就绪');
  
  // 优雅退出
  process.on('SIGINT', () => {
    console.log('\n[守护进程] 收到 SIGINT，正在关闭...');
    cleanup();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n[守护进程] 收到 SIGTERM，正在关闭...');
    cleanup();
    process.exit(0);
  });
  
  process.on('exit', () => {
    cleanup();
  });
}

// ============================================================================
// CLI 入口
// ============================================================================

const args = process.argv.slice(2);

if (args.includes('--stop')) {
  // 停止守护进程
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8'));
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`已发送停止信号到进程 ${pid}`);
    } catch {
      console.log('守护进程未运行');
    }
    cleanup();
  } else {
    console.log('守护进程未运行');
  }
} else if (args.includes('--status')) {
  // 查看状态
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8'));
    try {
      process.kill(pid, 0); // 检查进程是否存在
      console.log(`守护进程运行中 (PID: ${pid})`);
    } catch {
      console.log('守护进程未运行 (PID 文件存在但进程不存在)');
      cleanup();
    }
  } else {
    console.log('守护进程未运行');
  }
} else {
  // 启动守护进程
  start().catch(console.error);
}
