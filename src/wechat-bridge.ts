// ============================================================================
// 微信桥接层 - 连接 WeChat 客户端和守护进程
// ============================================================================

import { WeixinClient, SessionExpiredError } from './wechat-client.js';
import { loadCredentials, saveCredentials, loadConfig } from './config.js';
import { DaemonState } from './daemon-state.js';
import type { IncomingMessage } from './wechat-types.js';
import { spawnPiProcess, type PiSpawnResult } from './pi-spawn.js';
import { getSession } from './session-discover.js';

// ============================================================================
// 微信桥接
// ============================================================================

export class WechatBridge {
  private client: WeixinClient | null = null;
  private running = false;
  private pollAbort: AbortController | null = null;
  private state: DaemonState;
  private welcomeSent = false;
  // 是否已发送欢迎消息
  
  constructor(state: DaemonState) {
    this.state = state;
  }
  
  // 初始化（尝试使用已有凭证）
  async init(): Promise<boolean> {
    const credentials = loadCredentials();
    if (!credentials) {
      console.log('[微信] 没有保存的凭证');
      return false;
    }
    
    try {
      this.client = await WeixinClient.create(credentials);
      // 先不设置 loggedIn，等轮询成功后再设置
      this.state.wechat.accountId = this.client.accountId;
      this.state.wechat.userId = this.client.userId;
      console.log(`[微信] 已加载凭证: ${this.client.accountId}`);
      return true;
    } catch (e) {
      console.error('[微信] 加载凭证失败:', e);
      return false;
    }
  }
  
  // 开始轮询
  async startPolling(): Promise<void> {
    if (!this.client) {
      throw new Error('微信客户端未初始化');
    }
    
    this.running = true;
    this.state.wechat.running = true;
    this.pollAbort = new AbortController();
    
    console.log('[微信] 开始轮询消息');
    
    // 后台轮询
    this.pollLoop(this.client).catch(err => {
      console.error('[微信] 轮询异常退出:', err);
    });
  }
  
  // 停止轮询
  async stopPolling(): Promise<void> {
    this.running = false;
    this.state.wechat.running = false;
    this.state.wechat.connected = false;
    this.pollAbort?.abort();
    this.pollAbort = null;
  }
  
  // 轮询循环
  private async pollLoop(client: WeixinClient): Promise<void> {
    let retryDelay = 1000;
    let firstSuccess = true;
    
    while (this.running && this.client === client) {
      try {
        const messages = await client.getUpdates(this.pollAbort?.signal);
        retryDelay = 1000; // 重置重试延迟
        
        // 第一次成功轮询，标记为已登录和已连接
        if (firstSuccess) {
          firstSuccess = false;
          this.state.wechat.loggedIn = true;
          this.state.wechat.connected = true;
          console.log('[微信] 连接成功，开始接收消息');
        }
        
        // 并行处理消息（不阻塞轮询）
        for (const message of messages) {
          this.handleMessage(message);
        }
      } catch (error) {
        if (this.pollAbort?.signal.aborted) break;
        
        if (error instanceof SessionExpiredError) {
          console.error('[微信] Session 已过期');
          this.state.resetWechatStatus();
          break;
        }
        
        // terminated 是正常超时，不输出日志
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg !== 'terminated') {
          console.error('[微信] 轮询失败:', error);
        }
        await new Promise(r => setTimeout(r, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 30000);
      }
    }
  }
  
  // 处理收到的消息（非阻塞，立即返回）
  private handleMessage(message: IncomingMessage): void {
    console.log(`[微信] 收到消息: type=${message.type}, userId=${message.userId}, text=${message.text?.slice(0, 50)}`);
    
    const text = message.text?.trim() || '';
    const isCommand = text.startsWith('/');
    
    // 非命令消息：立即发送 typing 状态（表示"看到了"，不消耗 context_token）
    if (!isCommand) {
      this.sendTyping(message.userId, 1).catch(() => {});
    }
    
    // 异步处理，不阻塞消息接收
    this.processMessageAsync(message, text, isCommand).catch(err => {
      console.error('[微信] 处理消息异常:', err);
    });
  }
  
  // 异步处理消息（不阻塞主循环）
  private async processMessageAsync(message: IncomingMessage, text: string, isCommand: boolean): Promise<void> {
    // 首次消息发送简洁欢迎
    if (!this.welcomeSent) {
      this.welcomeSent = true;
      this.sendText(message.userId, '👋 pi 已连接，直接发消息即可对话').catch(() => {});
    }
    
    // 拦截「关闭 @别名」— 用户回复 daemon 的超时通知，不走 LLM
    if (!isCommand) {
      const closeMatch = text.match(/^关闭\s*@(\S+)/i) || text.match(/^确认关闭\s*@(\S+)/i);
      if (closeMatch) {
        const alias = closeMatch[1];
        const ps = this.state.findByAlias(alias);
        if (ps) {
          console.log(`[微信] 收到关闭确认: @${alias}`);
          this.state.killPendingSessionProcess(ps);
          this.state.markPendingKilled(ps.sessionId);
          await this.sendText(message.userId, `✅ 已关闭 @${alias}`);
          return;
        }
      }
    }
    
    // 处理命令（以 / 开头）
    if (isCommand) {
      const [command, ...args] = text.slice(1).split(/\s+/);
      const argsStr = args.join(' ');
      
      // 直接在守护进程处理命令
      await this.handleCommand(command.toLowerCase(), argsStr, message.userId);
      return;
    }
    
    // 路由消息
    const targetSessionId = await this.routeMessage(message);
    
    // @别名 指定了目标但找不到 → 提示用户，不 fallback
    if (targetSessionId === '__not_found__') {
      const mentionedName = message.text?.match(/^@(\S+)/)?.[1] || '';
      console.log(`[微信] @${mentionedName} 未找到匹配的 pi`);
      this.sendText(message.userId, `❌ 未找到 @${mentionedName} 对应的 pi\n\n使用 /sessions 查看可用列表，或 /alias 设置别名`).catch(() => {});
      return;
    }
    
    if (!targetSessionId) {
      console.log('[微信] 无法路由消息，没有可用的 session');
      this.sendText(message.userId, '❌ 没有可用的 pi session，请先启动 pi').catch(() => {});
      return;
    }
    
    console.log(`[微信] 路由消息到 session: ${targetSessionId}`);
    
    // 处理消息文本：去掉 @别名 或 @sessionid 部分
    let messageText = message.text || '';
    if (messageText.startsWith('@')) {
      const spaceIndex = messageText.indexOf(' ');
      if (spaceIndex > 0) {
        messageText = messageText.slice(spaceIndex + 1).trim();
      }
    }
    
    // 空消息检查（@mention 后没有正文，也没有图片）
    if (!messageText && !message.imageUrls?.length) {
      this.sendText(message.userId, '❌ 请发送消息内容').catch(() => {});
      return;
    }
    
    // 构造消息数据
    const messageData: any = {
      userId: message.userId,
      text: messageText,
      images: [],
      timestamp: Date.now(),
    };
    
    // 下载图片到临时文件
    if (message.imageUrls?.length) {
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { join: jp } = await import('node:path');
      const { tmpdir: td } = await import('node:os');
      const tmpDir = mkdtempSync(jp(td(), 'pi-wechat-img-'));
      for (let i = 0; i < message.imageUrls.length; i++) {
        const img = message.imageUrls[i];
        try {
          const resp = await fetch(img.url);
          const buf = Buffer.from(await resp.arrayBuffer());
          const tmpPath = jp(tmpDir, `img_${i}.jpg`);
          writeFileSync(tmpPath, buf);
          messageData.images.push(tmpPath);
        } catch (e) {
          console.error('[微信] 下载图片失败:', e);
        }
      }
    }
    
    // 检查目标 session 是否有 pi 在运行
    const conn = this.state.connections.get(targetSessionId);
    if (conn?.socket.writable) {
      console.log(`[微信] 推送消息到 pi session: ${targetSessionId}`);
      // 记录最近任务（用于 /progress）
      this.state.setLastTask(targetSessionId, messageText.slice(0, 200));
      this.state.touchActivity(targetSessionId);
      this.state.sendToSession(targetSessionId, 'wechat_message', messageData);
    } else {
      // ===== 启动追踪 + 防重复启动 =====

      // 检查 PendingSession 状态
      const ps = this.state.findBySessionId(targetSessionId);
      
      // killed：不自动启动
      if (ps?.status === 'killed') {
        console.log(`[微信] @${ps.alias} 已被关闭，不自动启动`);
        this.state.enqueueMessage(targetSessionId, {
          id: `msg_${Date.now()}`,
          sessionId: targetSessionId,
          userId: message.userId,
          text: message.text,
          images: messageData.images,
          timestamp: Date.now(),
          retries: 0,
          expiresAt: 0,
        });
        return;
      }
      
      // PendingSession 正在首次连接中：只入队，不重复启动
      // timeout / inactive 允许再次拉起（锁屏失败、空闲回收后可复活）
      if (ps && ps.status === 'pending') {
        console.log(`[微信] @${ps.alias} 正在等待连接，入队消息（不重复启动）`);
        this.state.enqueueMessage(targetSessionId, {
          id: `msg_${Date.now()}`,
          sessionId: targetSessionId,
          userId: message.userId,
          text: message.text,
          images: messageData.images,
          timestamp: Date.now(),
          retries: 0,
          expiresAt: 0,
        });
        this.sendText(message.userId, `⏳ @${ps.alias} 正在等待连接，消息已缓存`).catch(() => {});
        return;
      }

      // 检查是否正在启动中
      if (this.state.isStartupPending(targetSessionId)) {
        const attempt = this.state.startupTracker.get(targetSessionId)!;
        const elapsed = Math.floor((Date.now() - attempt.startedAt) / 1000);
        console.log(`[微信] pi 正在启动中（${elapsed}s），跳过重复启动`);
        this.sendText(message.userId, `⏳ pi 正在启动中（${elapsed}s），请稍候...`).catch(() => {});
        // 仍然入队，等连接后投递
        this.state.enqueueMessage(targetSessionId, {
          id: `msg_${Date.now()}`,
          sessionId: targetSessionId,
          userId: message.userId,
          text: message.text,
          images: messageData.images,
          timestamp: Date.now(),
          retries: 0,
          expiresAt: 0, // enqueueMessage 会覆盖
        });
        return;
      }

      // 检查上次是否启动失败
      if (this.state.hasStartupFailed(targetSessionId)) {
        console.log(`[微信] pi 上次启动失败，不再自动启动`);
        this.sendText(message.userId, '⚠️ pi 上次启动失败，请手动打开终端运行 pi。消息已缓存').catch(() => {});
        this.state.enqueueMessage(targetSessionId, {
          id: `msg_${Date.now()}`,
          sessionId: targetSessionId,
          userId: message.userId,
          text: message.text,
          images: messageData.images,
          timestamp: Date.now(),
          retries: 0,
          expiresAt: 0,
        });
        return;
      }

      // 注册启动追踪
      this.state.setStartup(targetSessionId, message.userId);
      
      // 入队消息
      this.state.setLastTask(targetSessionId, message.text?.slice(0, 200) || '');
      this.state.enqueueMessage(targetSessionId, {
        id: `msg_${Date.now()}`,
        sessionId: targetSessionId,
        userId: message.userId,
        text: message.text,
        images: messageData.images,
        timestamp: Date.now(),
        retries: 0,
        expiresAt: 0,
      });
      
      // 分阶段启动
      this.state.updateStartupStage(targetSessionId, 'starting');
      await this.sendText(message.userId, '⏳ 正在准备启动 pi...');
      
      const spawnResult = this.spawnPiSession(targetSessionId, message.userId);
      
      if (spawnResult.ok) {
        this.state.updateStartupStage(targetSessionId, 'waiting_connect');
        await this.sendText(message.userId, this.spawnWaitHint(spawnResult, targetSessionId.slice(0, 8)));
        
        // 后台一般数秒内连上；GUI 锁屏场景不可靠，给 20s
        const waitMs = spawnResult.mode === 'background' ? 20_000 : 15_000;
        const connected = await this.waitForPiConnect(targetSessionId, waitMs);
        
        if (connected) {
          this.state.clearStartup(targetSessionId);
          this.state.touchActivity(targetSessionId);
          console.log(`[微信] pi 已连接: ${targetSessionId.slice(0, 8)} mode=${spawnResult.mode}`);
          if (spawnResult.mode === 'background') {
            await this.sendText(
              message.userId,
              `✅ pi 已在后台连接（无 GUI）\n空闲一段时间后会自动释放，有新消息会再拉起`,
            ).catch(() => {});
          }
        } else {
          // 允许下一条消息立即重试
          this.state.clearStartup(targetSessionId);
          console.log(`[微信] pi 连接超时: ${targetSessionId.slice(0, 8)} mode=${spawnResult.mode}`);
          await this.sendText(
            message.userId,
            spawnResult.mode === 'background'
              ? '❌ 后台启动超时，消息已缓存。请再发一条重试，或检查本机 pi 是否可用'
              : '❌ pi 启动超时，请检查终端窗口。之后发送的消息会再次尝试启动',
          );
        }
      } else {
        this.state.updateStartupStage(targetSessionId, 'failed');
        console.log(`[微信] pi 启动失败: ${targetSessionId.slice(0, 8)}`, spawnResult.error);
        await this.sendText(message.userId, `⚠️ pi 启动失败：${spawnResult.error || '未知错误'}`);
      }
    }
  }
  
  // 处理微信命令
  private async handleCommand(command: string, args: string, userId: string): Promise<void> {
    console.log(`[微信] 处理命令: /${command} ${args}`);
    
    switch (command) {
      case 'help': {
        const helpText = `**📱 可用命令**

`
          + `**💬 消息**
`
          + `- 直接发 → 发给默认 pi
`
          + `- @[唯一标识] 消息 → 发给指定 pi
`
          + `
`
          + `**📂 Session**
`
          + `- /new → 新建 pi
`
          + `- /new [唯一标识] [消息] → 指定名字和首条消息
`
          + `- /new /path [唯一标识] [消息] → 指定目录
`
          + `- /switch [唯一标识] → 切换默认 pi
`
          + `- /sessions → 列出所有 pi
`
          + `
`
          + `**🎛️ 控制**
`
          + `- /stop [唯一标识] → 中断操作
`
          + `- /kill [唯一标识] → 终止进程
`
          + `- /progress [唯一标识] → 查看进度
`
          + `
`
          + `**🤖 AI**
`
          + `- /model [模型名] → 列出/切换模型
`
          + `- /context → 查询上下文用量
`
          + `- /compact → 压缩上下文
`
          + `
`
          + `**🏷️ 别名**
`
          + `- /alias → 列出所有别名（完整 sessionId）
`
          + `- /alias [名字] → 查询/设置（已存在=查ID，不存在=起名）
`
          + `
`
          + `**⏰ 定时**
`
          + `- /cron → 查看定时任务
`
          + `- /cron [名字] → 查看详情
`
          + `- /cron remove [名字] → 删除
`
          + `
`
          + `**📊 其他**
`
          + `- /status → 连接状态
`
          + `- /help → 显示本帮助`;
        await this.sendText(userId, helpText);
        break;
      }
      
      case 'status': {
        const status = this.getStatus();
        
        // 获取活跃 session 列表
        const activeSessions = Array.from(this.state.connections.entries())
          .filter(([_, conn]) => conn.socket.writable)
          .map(([id, _]) => id);
        
        // 默认 session 的显示名（优先 PendingSession alias，其次 aliases.json）
        const defaultSession = this.state.defaultSessionId;
        let defaultDisplayName = '无';
        if (defaultSession) {
          const ps = this.state.findBySessionId(defaultSession);
          if (ps) {
            defaultDisplayName = `@${ps.alias}`;
          } else {
            const aliases = await this.getAliases();
            for (const [alias, sid] of Object.entries(aliases)) {
              if (sid === defaultSession) { defaultDisplayName = `@${alias}`; break; }
            }
            if (defaultDisplayName === '无') defaultDisplayName = defaultSession.slice(0, 8) + '...';
          }
        }
        
        // 获取定时任务列表
        const cronTasks = this.state.getCronTasks();
        
        let statusText = `**📊 微信桥接**\n\n`;
        statusText += `- 微信：${status.connected ? '✅ 已连接' : '❌ 未连接'}\n`;
        statusText += `- 当前：${defaultDisplayName}\n`;
        statusText += `- 活跃 pi：${activeSessions.length} 个\n`;
        
        // pending sessions 统计
        const pendingList = this.state.getPendingSessions();
        const pendingCount = pendingList.filter(ps => ps.status === 'pending' || ps.status === 'timeout').length;
        if (pendingCount > 0) {
          statusText += `- 等待连接：${pendingCount} 个\n`;
        }
        
        if (activeSessions.length > 0) {
          statusText += `\n**活跃 Sessions：**\n`;
          for (const id of activeSessions) {
            const isDefault = id === defaultSession;
            const marker = isDefault ? '→' : ' ';
            const conn = this.state.connections.get(id);
            const ps = this.state.findBySessionId(id);
            const displayName = ps ? `@${ps.alias}` :
                               conn?.name ? `@${conn.name}` :
                               `${id.slice(0, 8)}...`;
            statusText += `${marker} ${displayName}${isDefault ? ' (默认)' : ''}\n`;
          }
        }
        
        if (cronTasks.length > 0) {
          statusText += `\n**⏰ 定时任务：**\n`;
          for (const task of cronTasks) {
            statusText += `- ${task.schedule}：${task.task}\n`;
          }
        }
        
        await this.sendText(userId, statusText);
        break;
      }
      
      case 'sessions': {
        const { listSessions } = await import('./session-discover.js');
        const diskSessions = listSessions();
        const pendingList = this.state.getPendingSessions();
        
        // 获取别名映射
        const aliases = await this.getAliases();
        
        // 构建统一列表项
        interface UnifiedItem {
          id: string;
          displayName: string;
          status: string;      // 状态图标
          summary: string;
          time: string;
          sortKey: number;     // 排序权重：0=connected, 1=pending/timeout, 2=inactive, 3=killed
        }
        
        const items: UnifiedItem[] = [];
        const seenIds = new Set<string>();
        
        // 1. 磁盘 sessions
        for (const s of diskSessions) {
          const conn = this.state.connections.get(s.id);
          const isActive = conn?.socket.writable;
          const ps = this.state.findBySessionId(s.id);
          
          const alias = aliases[s.id] || ps?.alias || s.name;
          const displayName = alias ? `@${alias}` : s.id.slice(0, 8);
          
          // 状态：优先 PendingSession 的状态
          let status: string;
          let sortKey: number;
          if (ps) {
            switch (ps.status) {
              case 'connected': status = '🟢'; sortKey = 0; break;
              case 'pending': case 'timeout': status = ps.status === 'timeout' ? '⏰' : '⏳'; sortKey = 1; break;
              case 'inactive': status = '⚪'; sortKey = 2; break;
              case 'killed': status = '🛑'; sortKey = 3; break;
              default: status = '⚪'; sortKey = 2;
            }
          } else {
            status = isActive ? '🟢' : '⚪';
            sortKey = isActive ? 0 : 2;
          }
          
          // 摘要
          let summary = '';
          if (ps?.initialMessage) {
            summary = ps.initialMessage.slice(0, 24);
          } else if (s.lastMessage) {
            const clean = s.lastMessage.replace(/\n/g, ' ').trim();
            summary = clean.length <= 24 ? clean : clean.slice(0, 24) + '…';
          } else {
            summary = s.messageCount > 0 ? '(无文字)' : '(空)';
          }
          
          // 时间
          const diff = Date.now() - s.modified.getTime();
          let time: string;
          if (diff < 60000) time = '刚刚';
          else if (diff < 3600000) time = `${Math.floor(diff / 60000)} 分钟前`;
          else {
            const now = new Date();
            const isToday = now.toDateString() === s.modified.toDateString();
            const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
            const isYesterday = yesterday.toDateString() === s.modified.toDateString();
            const hm = s.modified.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            if (isToday) time = hm;
            else if (isYesterday) time = `昨天 ${hm}`;
            else time = `${s.modified.getMonth() + 1}/${s.modified.getDate()} ${hm}`;
          }
          
          items.push({ id: s.id, displayName, status, summary, time, sortKey });
          seenIds.add(s.id);
        }
        
        // 2. PendingSessions 中没有磁盘记录的
        for (const ps of pendingList) {
          if (seenIds.has(ps.sessionId)) continue;
          
          const statusIcon = ps.status === 'connected' ? '🟢' :
                             ps.status === 'pending' ? '⏳' :
                             ps.status === 'inactive' ? '⚪' :
                             ps.status === 'timeout' ? '⏰' : '🛑';
          const sortKey = ps.status === 'connected' ? 0 :
                          ps.status === 'pending' || ps.status === 'timeout' ? 1 :
                          ps.status === 'inactive' ? 2 : 3;
          
          items.push({
            id: ps.sessionId,
            displayName: `@${ps.alias}`,
            status: statusIcon,
            summary: ps.initialMessage?.slice(0, 24) || '',
            time: '刚创建',
            sortKey,
          });
        }
        
        if (items.length === 0) {
          await this.sendText(userId, '❌ 没有找到 session');
          break;
        }
        
        // 排序 + 限制数量
        items.sort((a, b) => a.sortKey - b.sortKey);
        const displayItems = items.slice(0, 10);
        
        const total = items.length;
        const header = total > 10
          ? `**📋 Sessions（${total} 个，显示前 10 个）**`
          : `**📋 Sessions（${total} 个）**`;
        const lines = displayItems.map(item =>
          `- ${item.status} ${item.displayName}  ${item.summary}  ${item.time}`
        );
        
        await this.sendText(userId, `${header}\n\n${lines.join('\n')}\n\n💡 使用 /switch <id> 切换 session`);
        break;
      }
      
      case 'alias': {
        const name = args?.trim();
        const aliases = await this.getAliases();
        
        if (!name) {
          // /alias → 列出所有别名
          if (Object.keys(aliases).length === 0) {
            await this.sendText(userId, 'ℹ️ **没有设置别名**\n\n使用 /alias [名字] 给当前 pi 起名');
          } else {
            const aliasList = Object.entries(aliases).map(([k, v]) => `- @${k} → \`${v}\``).join('\n');
            await this.sendText(userId, `**📋 别名列表：**\n\n${aliasList}`);
          }
        } else if (aliases[name]) {
          // /alias <已存在的别名> → 查询完整 sessionId
          await this.sendText(userId, `@${name} → \`${aliases[name]}\``);
        } else {
          // /alias <新名字> → 给当前 session 起名
          const currentSession = this.state.defaultSessionId;
          if (!currentSession) {
            await this.sendText(userId, '❌ 没有当前 session，请先启动 pi');
          } else {
            const result = await this.setAlias(name, currentSession);
            if (result === 'ok') {
              await this.sendText(userId, `✅ 已设置别名：@${name} → \`${currentSession}\``);
            } else {
              await this.sendText(userId, result);
            }
          }
        }
        break;
      }
      
      case 'aliases': {
        const aliases = await this.getAliases();
        if (Object.keys(aliases).length === 0) {
          await this.sendText(userId, 'ℹ️ **没有设置别名**');
        } else {
          const aliasList = Object.entries(aliases).map(([k, v]) => `- @${k} → ${v.slice(0, 8)}...`).join('\n');
          await this.sendText(userId, `**📋 别名列表：**\n\n${aliasList}`);
        }
        break;
      }
      
      case 'new': {
        // 创建新 session + 打开终端
        const { homedir } = await import('node:os');
        
        // 解析参数：/new [别名] [/path/to/project] [消息]
        let projectPath = homedir();
        let aliasName = '';
        let message = '';
        
        if (args) {
          const parts = args.split(/\s+/);
          let i = 0;
          
          // 1. 检查是否有路径
          if (i < parts.length && parts[i].startsWith('/')) {
            projectPath = parts[i];
            i++;
          }
          
          // 2. 剩余参数：第一个是名称，其他是消息
          const remaining = parts.slice(i);
          if (remaining.length === 0) {
            message = '来自微信';
          } else if (remaining.length === 1) {
            message = remaining[0];
          } else {
            aliasName = remaining[0];
            message = remaining.slice(1).join(' ');
          }
        } else {
          message = '来自微信';
        }
        if (!message) message = '来自微信';
        
        const sessionId = `wechat-${Date.now()}`;
        const alias = aliasName || sessionId;
        
        console.log(`[微信] /new alias=${alias}, sessionId=${sessionId.slice(0,8)}, projectPath=${projectPath}`);
        
        // 创建 PendingSession
        this.state.createPendingSession({
          alias,
          sessionId,
          projectPath,
          createdBy: userId,
          initialMessage: message,
        });
        
        // 入队初始消息（pi 连接后自动投递）
        this.state.enqueueMessage(sessionId, {
          id: `msg_${Date.now()}`,
          sessionId,
          userId,
          text: message,
          images: [],
          timestamp: Date.now(),
          retries: 0,
          expiresAt: 0,
        });
        
        // 注册别名 → sessionId 映射
        await this.setAlias(alias, sessionId);
        
        // 设置默认 session
        this.state.defaultSessionId = sessionId;
        
        // 按锁屏状态选择 GUI 或 daemon 内联 rpc 后台启动
        await this.sendText(userId, '⏳ 正在准备启动 pi...');
        const spawnResult = spawnPiProcess({
          sessionId,
          name: alias,
          label: alias,
        });
        if (spawnResult.ok) {
          this.state.trackManagedSpawn({
            sessionId,
            mode: spawnResult.mode,
            backend: spawnResult.backend,
            childPid: spawnResult.childPid,
            userId,
          });
        }
        console.log(
          `[微信] /new spawn mode=${spawnResult.mode} backend=${spawnResult.backend || '-'} reason=${spawnResult.reason} ok=${spawnResult.ok} pid=${spawnResult.childPid || '-'}`,
        );

        if (!spawnResult.ok) {
          await this.sendText(userId, `⚠️ @${alias} 启动失败：${spawnResult.error || '未知错误'}`);
          break;
        }

        await this.sendText(userId, this.spawnWaitHint(spawnResult, alias));

        // 后台：短等；GUI：保留分阶段长等（权限弹窗等）
        let connected = false;
        if (spawnResult.mode === 'background') {
          connected = await this.waitForPiConnect(sessionId, 20_000);
          if (!connected) {
            const ps = this.state.findByAlias(alias);
            if (ps?.status === 'connected') connected = true;
          }
        } else {
          const stages = [
            { ms: 15_000, msg: null as string | null },
            { ms: 30_000, msg: `⏰ @${alias} 已等待 30s，仍在连接中...` },
            { ms: 60_000, msg: `⏰ @${alias} 已等待 1 分钟，可能是权限弹窗导致。` },
          ];
          for (const stage of stages) {
            connected = await this.waitForPiConnect(sessionId, stage.ms);
            if (connected) break;
            const ps = this.state.findByAlias(alias);
            if (ps?.status === 'connected') { connected = true; break; }
            if (stage.msg) await this.sendText(userId, stage.msg).catch(() => {});
          }
        }

        if (connected) {
          this.state.touchActivity(sessionId);
          console.log(`[微信] /new pi 已连接: ${alias} mode=${spawnResult.mode}`);
          if (spawnResult.mode === 'background') {
            await this.sendText(
              userId,
              `✅ @${alias} 已在后台连接（无 GUI 窗口）\n` +
              `说明：当前线程不在终端里常驻，空闲一段时间后会自动释放；有新消息会再拉起。`,
            ).catch(() => {});
          }
        } else {
          console.log(`[微信] /new 超时但保留 pending: ${alias} mode=${spawnResult.mode}`);
          await this.sendText(userId,
            spawnResult.mode === 'background'
              ? `⏰ @${alias} 后台启动超时未连接\n\n` +
                `请再发一条消息重试，或检查本机 pi 是否可用。\n` +
                `连接后消息会自动投递。回复「关闭 @${alias}」取消`
              : `⏰ @${alias} 已超过等待时间未连接\n\n` +
                `可能原因：终端未打开、权限弹窗、或屏幕锁定\n` +
                `连接后消息会自动投递。回复「关闭 @${alias}」来取消`,
          ).catch(() => {});
        }
        break;
      }
      
      case 'reset': {
        // 清空 session 上下文
        let targetSessionId = this.state.defaultSessionId;
        
        if (args) {
          // 通过别名或 ID 查找
          const aliases = await this.getAliases();
          targetSessionId = aliases[args] || await this.findSessionById(args);
        }
        
        if (!targetSessionId) {
          await this.sendText(userId, '❌ 没有找到 session');
          break;
        }
        
        // 发送 reset 命令给 pi
        const conn = this.state.connections.get(targetSessionId);
        if (conn?.socket.writable) {
          this.state.sendToSession(targetSessionId, 'wechat_command', { command: 'reset', userId });
        } else {
          const ps = this.state.findBySessionId(targetSessionId);
          const name = ps ? `@${ps.alias}` : `${targetSessionId.slice(0, 8)}...`;
          await this.sendText(userId, `⏳ ${name} 尚未连接，无法执行 /reset`);
        }
        break;
      }
      
      case 'stop': {
        // 停止当前操作（支持 /stop 或 /stop <name|id>）
        let targetSessionId = this.state.defaultSessionId;
        
        if (args) {
          // 通过别名或 ID 查找
          const aliases = await this.getAliases();
          targetSessionId = aliases[args] || await this.findSessionById(args);
        }
        
        if (!targetSessionId) {
          await this.sendText(userId, '❌ 没有找到 session');
          break;
        }
        
        // 检查连接是否存在
        const stopConn = this.state.connections.get(targetSessionId);
        if (!stopConn?.socket.writable) {
          const _ps = this.state.findBySessionId(targetSessionId);
          const name = _ps ? `@${_ps.alias}` : `${targetSessionId.slice(0, 8)}...`;
          await this.sendText(userId, `⏳ ${name} 尚未连接，无法执行 /stop`);
          break;
        }
        
        this.state.sendToSession(targetSessionId, 'wechat_command', { command: 'stop', userId });
        break;
      }
      
      case 'kill': {
        // 强制终止 pi 进程（支持 /kill 或 /kill <name|id>）
        let targetSessionId = this.state.defaultSessionId;
        let targetAlias = '';
        
        if (args) {
          // 先通过别名查找 PendingSession
          const ps = this.state.findByAlias(args);
          if (ps) {
            targetSessionId = ps.sessionId;
            targetAlias = ps.alias;
          } else {
            // 通过别名或 ID 查找
            const aliases = await this.getAliases();
            targetSessionId = aliases[args] || await this.findSessionById(args);
          }
        }
        
        if (!targetSessionId) {
          await this.sendText(userId, '❌ 没有找到 session');
          break;
        }
        
        // 找到对应的 PendingSession 并标记为 killed
        const ps = this.state.findBySessionId(targetSessionId);
        if (ps) {
          this.state.killPendingSessionProcess(ps);
          this.state.markPendingKilled(targetSessionId);
        }
        
        // 同时尝试 kill 已连接的 pi 进程
        const conn = this.state.connections.get(targetSessionId);
        if (conn) {
          try { process.kill(conn.pid, 'SIGTERM'); } catch {}
        }
        
        const displayName = targetAlias || ps?.alias || targetSessionId.slice(0, 8);
        
        // 切换到其他活跃 session
        const isDefault = targetSessionId === this.state.defaultSessionId;
        if (isDefault) {
          const otherSession = Array.from(this.state.connections.entries())
            .find(([id, c]) => id !== targetSessionId && c.socket.writable);
          if (otherSession) {
            this.state.defaultSessionId = otherSession[0];
            await this.sendText(userId, `🛑 已终止 ${displayName}，已切换到 ${otherSession[0].slice(0, 8)}...`);
          } else {
            this.state.defaultSessionId = null;
            await this.sendText(userId, `🛑 已终止 ${displayName}，无其他活跃 session`);
          }
        } else {
          await this.sendText(userId, `🛑 已终止 ${displayName}`);
        }
        break;
      }
      
      case 'progress': {
        // 查询任务进度（支持 /progress 或 /progress <name|id>）
        let targetSessionId = this.state.defaultSessionId;
        
        if (args) {
          // 通过别名或 ID 查找
          const aliases = await this.getAliases();
          targetSessionId = aliases[args] || await this.findSessionById(args);
        }
        
        if (!targetSessionId) {
          await this.sendText(userId, '❌ 没有找到 session');
          break;
        }
        
        // 读取进度信息（从连接信息中获取）
        const conn = this.state.connections.get(targetSessionId);
        if (!conn) {
          const _ps2 = this.state.findBySessionId(targetSessionId);
          const name = _ps2 ? `@${_ps2.alias}` : `${targetSessionId.slice(0, 8)}...`;
          await this.sendText(userId, `⏳ ${name} 尚未连接，无法查看进度`);
          break;
        }
        
        const sessionShort = targetSessionId.slice(0, 8);
        const progress = this.state.getProgress(targetSessionId);
        
        // 计算最后活跃时间
        const lastActive = conn.lastHeartbeat;
        const timeSinceLastActive = Date.now() - lastActive.getTime();
        const lastActiveText = timeSinceLastActive < 60000 ? '刚刚' : 
          timeSinceLastActive < 3600000 ? `${Math.floor(timeSinceLastActive / 60000)} 分钟前` : 
          `${Math.floor(timeSinceLastActive / 3600000)} 小时前`;
        
        // 判断状态
        const idle = timeSinceLastActive > 120000; // 2分钟
        
        let progressText = `**📊 @${sessionShort}**\n\n`;
        
        // 最近任务
        if (progress.lastTask) {
          const taskPreview = progress.lastTask.length > 80 
            ? progress.lastTask.slice(0, 80) + '...'
            : progress.lastTask;
          progressText += `- 最近任务：${taskPreview}\n`;
        }
        
        if (idle) {
          progressText += `- 状态：⚪ 空闲\n`;
          progressText += `- 最后活跃：${lastActiveText}\n`;
        } else {
          progressText += `- 状态：🟢 运行中\n`;
          if (progress.startTime) {
            const runtime = Math.floor((Date.now() - progress.startTime) / 1000);
            const runtimeText = runtime > 60 ? `${Math.floor(runtime / 60)} 分钟` : `${runtime} 秒`;
            progressText += `- 已运行：${runtimeText}\n`;
          }
        }
        
        // 进度消息
        if (progress.messages.length > 0) {
          const latest = progress.messages[progress.messages.length - 1];
          progressText += `- 最新进度：${latest}\n`;
        }
        
        await this.sendText(userId, progressText);
        break;
      }
      
      case 'cron': {
        // /cron - 列表
        // /cron remove <名称> - 删除
        // /cron <名称> - 查看详情
        const [sub, ...rest] = args.split(/\s+/);
        
        if (!sub) {
          // /cron → 列表
          const tasks = this.state.getCronTasks();
          if (tasks.length === 0) {
            await this.sendText(userId, '📭 没有定时任务');
          } else {
            let text = '**⏰ 定时任务：**\n\n';
            for (const task of tasks) {
              const status = task.status === 'confirmed' ? '⏳' :
                             task.status === 'running' ? '🔄' :
                             task.status === 'completed' ? '✅' :
                             task.status === 'failed' ? '❌' : '📌';
              const next = task.nextRun ? new Date(task.nextRun).toLocaleTimeString() : '-';
              text += `${status} ${task.id.slice(-6)} | ${task.schedule} | ${next}\n`;
            }
            await this.sendText(userId, text);
          }
        } else if (sub === 'remove') {
          // /cron remove <名称>
          const taskName = rest.join(' ');
          if (!taskName) {
            await this.sendText(userId, '❌ 用法: /cron remove <任务名称>');
            break;
          }
          const task = this.state.findCronTaskByName(taskName);
          if (!task) {
            await this.sendText(userId, `❌ 未找到任务: ${taskName}`);
            break;
          }
          this.state.manageCronTask('remove', { taskId: task.id });
          await this.sendText(userId, `✅ 已删除: ${task.schedule} ${task.task}`);
        } else {
          // /cron <名称> → 详情
          const taskName = args;
          const task = this.state.findCronTaskByName(taskName);
          if (!task) {
            await this.sendText(userId, `❌ 未找到任务: ${taskName}`);
            break;
          }
          let text = `**⏰ ${task.schedule}**\n\n`;
          text += `- 任务：${task.task}\n`;
          text += `- 状态：${task.status}\n`;
          text += `- Session：${task.sessionId.slice(0, 8)}...\n`;
          if (task.nextRun) {
            text += `- 下次执行：${new Date(task.nextRun).toLocaleString()}\n`;
          }
          if (task.lastRun) {
            text += `- 上次执行：${new Date(task.lastRun).toLocaleString()}\n`;
          }
          if (task.lastResult) {
            text += `- 结果：${task.lastResult}\n`;
          }
          await this.sendText(userId, text);
        }
        break;
      }
      
      case 'switch': {
        // 切换 session（支持 ID、短 ID、名称、pending 别名）
        if (!args) {
          await this.sendText(userId, '❌ 请指定 session id、名称或别名\n\n用法: /switch <id 或 @别名>');
          break;
        }
        
        const target = args.replace(/^@/, '');
        
        // 1. 先查 PendingSession
        const ps = this.state.findByAlias(target);
        if (ps) {
          this.state.defaultSessionId = ps.sessionId;
          const statusText = ps.status === 'connected' ? '🟢 已连接' :
                             ps.status === 'pending' ? '⏳ 等待连接中' :
                             ps.status === 'inactive' ? '⚪ 未连接（可复活）' :
                             ps.status === 'timeout' ? '⏰ 超时未连接' :
                             ps.status === 'killed' ? '🛑 已关闭' : '⚪';
          await this.sendText(userId, `✅ 已切换到 @${ps.alias} ${statusText}`);
          if (ps.status === 'pending' || ps.status === 'timeout') {
            await this.sendText(userId, '💡 pi 尚未连接，连接后消息自动投递');
          }
          break;
        }
        
        // 2. 再查现有 sessions
        const { listSessions } = await import('./session-discover.js');
        const sessions = listSessions();
        let targetSession = sessions.find(s => s.id.startsWith(target));
        if (!targetSession) {
          targetSession = sessions.find(s => s.name && s.name.toLowerCase().includes(target.toLowerCase()));
        }
        
        if (!targetSession) {
          await this.sendText(userId, `❌ 未找到 session: ${target}`);
          break;
        }
        
        const conn = this.state.connections.get(targetSession.id);
        const isActive = conn?.socket.writable;
        
        this.state.defaultSessionId = targetSession.id;
        
        const status = isActive ? '🟢 已连接' : '⚪ 未连接';
        const sessionName = targetSession.name || targetSession.id.slice(0, 8);
        await this.sendText(userId, `✅ 已切换到 session:\n${sessionName} ${status}`);
        
        if (!isActive) {
          await this.sendText(userId, '💡 该 session 没有活跃的 pi，发送消息时会自动启动');
        }
        break;
      }
      
      default:
        // pi 侧命令：/model、/compact、/context
        if (['model', 'compact', 'context'].includes(command)) {
          const targetSessionId = this.state.defaultSessionId;
          if (!targetSessionId) {
            await this.sendText(userId, '❌ 没有活跃的 pi');
            break;
          }
          // 传参时区分命令类型
          const cmdArgs: any = { userId };
          if (command === 'model') cmdArgs.modelName = args || undefined;
          if (command === 'context') cmdArgs.alias = args || undefined;
          const sent = this.sendWechatCommand(targetSessionId, command, cmdArgs);
          if (!sent) {
            await this.sendText(userId, '❌ pi 未连接');
          }
          break;
        }
        await this.sendText(userId, `未知命令：/${command}，输入 /help 查看帮助`);
    }
  }
  
  // 获取别名（从 aliases.json 读取，与 daemon 的 loadAliases 保持一致）
  private async getAliases(): Promise<Record<string, string>> {
    const { loadAliases } = await import('./config.js');
    return loadAliases();
  }
  
  // 根据 ID 或短 ID 查找 session
  private async findSessionById(id: string): Promise<string | null> {
    // 1. 检查是否是完整的 session ID
    if (this.state.connections.has(id)) {
      return id;
    }
    
    // 2. 检查 PendingSession 的 sessionId
    const ps = this.state.findBySessionId(id);
    if (ps) return ps.sessionId;
    
    // 3. 检查是否是短 ID（前缀匹配）
    for (const connId of this.state.connections.keys()) {
      if (connId.startsWith(id)) {
        return connId;
      }
    }
    
    // 4. 通过 name 查找
    const { listSessions } = await import('./session-discover.js');
    const sessions = listSessions();
    const session = sessions.find((s: any) => s.name && s.name.toLowerCase().includes(id.toLowerCase()));
    return session ? session.id : null;
  }
  
  // 设置别名
  private async setAlias(name: string, sessionId: string): Promise<string> {
    const { saveAliases } = await import('./config.js');
    const aliases = await this.getAliases();
    const existing = aliases[name];
    
    aliases[name] = sessionId;
    saveAliases(aliases);
    
    if (existing && existing !== sessionId) {
      return `⚠️ @${name} 之前指向 ${existing.slice(0, 8)}，已更新 → ${sessionId.slice(0, 8)}`;
    }
    return `ok`;
  }
  
  // 路由消息到正确的 session
  // 返回 null 表示找不到目标（@mention 明确指定了目标但不存在）
  // 返回 '__not_found__' 表示 @别名 不存在，不要 fallback
  private async routeMessage(message: IncomingMessage): Promise<string | null> {
    const text = message.text?.trim() || '';
    
    // 检查是否是 @别名 或 @sessionid 消息
    if (text.startsWith('@')) {
      const spaceIndex = text.indexOf(' ');
      if (spaceIndex > 0) {
        const target = text.slice(1, spaceIndex);
        
        // 1. 先检查别名
        const aliases = await this.getAliases();
        if (aliases[target]) {
          console.log(`[微信] 通过别名 @${target} 路由到 session: ${aliases[target]}`);
          return aliases[target];
        }
        
        // 2. 再检查 session ID（支持短 ID 匹配）
        const { listSessions } = await import('./session-discover.js');
        const sessions = listSessions();
        const matchedSession = sessions.find(s => s.id.startsWith(target));
        if (matchedSession) {
          console.log(`[微信] 通过 session ID @${target} 路由到 session: ${matchedSession.id}`);
          return matchedSession.id;
        }
        
        // 3. 检查是否在 PendingSession 中（通过 /new 创建，尚未连接）
        const ps = this.state.findByAlias(target);
        if (ps && (ps.status === 'pending' || ps.status === 'timeout')) {
          console.log(`[微信] @${target} 在 pending 中，入队消息`);
          this.state.enqueueMessage(ps.sessionId, {
            id: `msg_${Date.now()}`,
            sessionId: ps.sessionId,
            userId: message.userId,
            text: message.text,
            images: [],
            timestamp: Date.now(),
            retries: 0,
            expiresAt: 0,
          });
          return ps.sessionId;  // 返回 sessionId，后续自动启动检查会处理
        }
        
        // @mention 明确指定了目标但找不到 → 不 fallback，直接返回未找到
        console.log(`[微信] @${target} 未找到匹配的别名或 session`);
        return '__not_found__';
      }
    }
    
    // 发给默认 session，如果没有则找最近的 session
    if (this.state.defaultSessionId) {
      return this.state.defaultSessionId;
    }
    
    // 尝试找最近的 session
    const { getLatestSession } = await import('./session-discover.js');
    const latest = getLatestSession();
    if (latest) {
      console.log(`[微信] 没有默认 session，使用最近的 session: ${latest.id}`);
      return latest.id;
    }
    
    return null;
  }
  
  // 发送文本消息
  async sendText(userId: string, text: string): Promise<void> {
    if (!this.client) throw new Error('微信客户端未初始化');
    await this.client.sendText(userId, text);
  }
  
  // 发送图片
  async sendImage(userId: string, filePath: string): Promise<void> {
    if (!this.client) throw new Error('微信客户端未初始化');
    await this.client.sendImage(userId, filePath);
  }
  
  // 发送文件
  async sendFile(userId: string, filePath: string, fileName?: string): Promise<void> {
    if (!this.client) throw new Error('微信客户端未初始化');
    await this.client.sendFile(userId, filePath, fileName);
  }
  
  // 发送"正在输入"状态
  async sendTyping(userId: string, status: 1 | 2 = 1): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.sendTyping(userId, status);
    } catch {}
  }
  
  // 发送欢迎消息
  /** 启动过程中给用户的提示（明确是否无 GUI） */
  private spawnWaitHint(result: PiSpawnResult, displayName: string): string {
    if (result.mode === 'background') {
      if (result.reason === 'screen_locked_rpc') {
        return (
          `🔒 检测到屏幕锁定，已在后台直接启动 @${displayName}（无 GUI 窗口）\n` +
          `等待 pi 连接中…`
        );
      }
      return `⏳ 已后台启动 @${displayName}（无 GUI），等待连接…`;
    }
    return `⏳ 终端已打开，等待 @${displayName} 连接…`;
  }

  // 自动启动 pi session（锁屏 → 内联 rpc，否则 GUI）
  private spawnPiSession(sessionId: string, userId?: string): PiSpawnResult {
    const session = getSession(sessionId);
    const cwd = session?.cwd || process.env.HOME || '/tmp';
    const name = session?.name || this.state.connections.get(sessionId)?.name
      || this.state.findBySessionId(sessionId)?.alias;

    console.log(`[微信] 自动启动 pi: session=${sessionId.slice(0, 8)}, cwd=${cwd}`);

    const result = spawnPiProcess({
      sessionId,
      name,
      label: sessionId.slice(0, 8),
    });

    if (result.ok) {
      this.state.trackManagedSpawn({
        sessionId,
        mode: result.mode,
        backend: result.backend,
        childPid: result.childPid,
        userId,
      });
      console.log(
        `[微信] pi 已启动: session=${sessionId.slice(0, 8)} mode=${result.mode} backend=${result.backend || '-'} reason=${result.reason} pid=${result.childPid || '-'}`,
      );
    } else {
      console.error('[微信] 启动 pi 失败:', result.error);
    }
    return result;
  }
  
  // 等待 pi 连接（轮询 connections，最多 timeoutMs 毫秒）
  private waitForPiConnect(sessionId: string, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const start = Date.now();
      const check = () => {
        if (this.state.connections.has(sessionId) && this.state.connections.get(sessionId)?.socket.writable) {
          resolve(true);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 1000);
      };
      check();
    });
  }
  
  // 获取状态
  getStatus(): any {
    return {
      loggedIn: this.state.wechat.loggedIn,
      connected: this.state.wechat.connected,
      running: this.state.wechat.running,
      accountId: this.state.wechat.accountId,
      userId: this.state.wechat.userId,
    };
  }
  
  // 发送命令到 pi 扩展（不经过 LLM）
  private sendWechatCommand(sessionId: string, command: string, args: any): boolean {
    return this.state.sendToSession(sessionId, 'wechat_command', {
      command,
      args,
      userId: args?.userId || '',
    });
  }
}
