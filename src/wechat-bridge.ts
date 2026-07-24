// ============================================================================
// 微信桥接层 - 连接 WeChat 客户端和守护进程
// ============================================================================

import { WeixinClient, SessionExpiredError } from './wechat-client.js';
import { loadCredentials, saveCredentials, loadConfig } from './config.js';
import { DaemonState } from './daemon-state.js';
import type { IncomingMessage } from './wechat-types.js';

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
      this.state.sendToSession(targetSessionId, 'wechat_message', messageData);
    } else {
      console.log(`[微信] pi session 未连接，尝试自动启动 pi...`);
      
      // 通知用户正在启动
      this.sendText(message.userId, '🚀 没有活跃的 pi，正在尝试启动...').catch(() => {});
      
      // 尝试自动启动 pi
      const spawned = await this.spawnPiSession(targetSessionId);
      
      // 入队消息（包含 userId，用于后续回复）
      this.state.enqueueMessage(targetSessionId, {
        id: `msg_${Date.now()}`,
        sessionId: targetSessionId,
        userId: message.userId,
        text: message.text,
        images: messageData.images,
        timestamp: Date.now(),
        retries: 0,
      });
      
      if (spawned) {
        console.log(`[微信] pi 已启动，消息已入队等待连接`);
        this.sendText(message.userId, '⏳ pi 启动中，消息已缓存，连接后会自动处理').catch(() => {});
      } else {
        console.log(`[微信] pi 启动失败，消息已入队`);
        this.sendText(message.userId, '⚠️ pi 启动失败，消息已缓存，请稍后重试或手动启动 pi').catch(() => {});
      }
    }
  }
  
  // 处理微信命令
  private async handleCommand(command: string, args: string, userId: string): Promise<void> {
    console.log(`[微信] 处理命令: /${command} ${args}`);
    
    switch (command) {
      case 'help': {
        const helpText = `**📱 可用命令：**

` +
        `**💬 消息路由：**
` +
        `- 直接发消息 → 发给默认 pi
` +
        `- @名字 消息 → 发给指定名字的 pi
` +
        `- @sessionId 消息 → 发给指定 id 的 pi（支持短 id 前缀）

` +
        `**📂 Session 管理：**
` +
        `- /new → 创建新 pi 窗口
` +
        `- /new 名字 消息 → 创建新 pi，指定名字和首条消息
` +
        `- /new /path 名字 消息 → 在指定目录创建
` +
        `- /switch 名字 → 切换默认 pi（不发 @ 就发给它）
` +
        `- /switch sessionId → 通过 id 切换（支持短 id 前缀）
` +
        `- /sessions → 列出所有 pi 及状态

` +
        `**🎛️ 会话控制：**
` +
        `- /stop → 中断当前 pi 的 AI 操作
` +
        `- /stop 名字 → 中断指定 pi 的操作
` +
        `- /kill → 强制终止当前 pi 进程
` +
        `- /kill 名字 → 强制终止指定 pi 进程
` +
        `- /progress → 查看当前 pi 的任务进度
` +
        `- /progress 名字 → 查看指定 pi 的任务进度

` +
        `**🤖 AI 控制：**
` +
        `- /model → 查看可用模型列表
` +
        `- /model 模型名 → 切换模型（如 /model deepseek-v4-flash）
` +
        `- /context → 查询当前上下文用量
` +
        `- /compact → 压缩上下文

` +
        `**🏷️ 别名管理：**
` +
        `- /alias 名字 → 给当前 pi 起个名字（之后用 @名字 找它）
` +
        `- /alias 名字 sessionId → 给指定 pi 起名字
` +
        `- /alias → 列出所有别名

` +
        `**⏰ 定时任务：**
` +
        `- /cron → 查看定时任务列表
` +
        `- /cron <名> → 查看任务详情
` +
        `- /cron remove <名> → 删除定时任务

` +
        `**📊 其他：**
` +
        `- /status → 查看连接状态
` +
        `- /help → 显示本帮助`;
        await this.sendText(userId, helpText);
        break;
      }
      
      case 'status': {
        const status = this.getStatus();
        
        // 获取活跃 session 列表
        const activeSessions = Array.from(this.state.connections.entries())
          .filter(([_, conn]) => conn.socket.writable)
          .map(([id, _]) => id);
        
        const defaultSession = this.state.defaultSessionId;
        const defaultSessionName = defaultSession ? (defaultSession.slice(0, 8) + '...') : '无';
        
        // 获取定时任务列表
        const cronTasks = this.state.getCronTasks();
        
        let statusText = `**📊 微信桥接**\n\n`;
        statusText += `- 微信：${status.connected ? '✅ 已连接' : '❌ 未连接'}\n`;
        statusText += `- 当前：${defaultSessionName}\n`;
        statusText += `- 活跃 pi：${activeSessions.length} 个\n`;
        
        if (activeSessions.length > 0) {
          statusText += `\n**活跃 Sessions：**\n`;
          for (const id of activeSessions) {
            const isDefault = id === defaultSession;
            const marker = isDefault ? '→' : ' ';
            statusText += `${marker} ${id.slice(0, 8)}...${isDefault ? ' (默认)' : ''}\n`;
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
        const { summarizeSessions } = await import('./llm-summarizer.js');
        
        const sessions = listSessions();
        if (sessions.length === 0) {
          await this.sendText(userId, '❌ 没有找到 session');
          break;
        }
        
        // 发送加载提示
        await this.sendText(userId, '⏳ 正在汇总 sessions...');
        
        // 获取别名映射（反向：sessionId -> alias）
        const aliases = await this.getAliases();
        const sessionToAlias = new Map<string, string>();
        for (const [alias, sessionId] of Object.entries(aliases)) {
          sessionToAlias.set(sessionId, alias);
        }
        
        // 批量摘要
        const summaries = await summarizeSessions(
          sessions.slice(0, 10).map((s: any) => ({ path: s.path, name: s.name }))
        );
        
        const sessionList = sessions.slice(0, 10).map((s: any) => {
          const name = s.name || s.id.slice(0, 8);
          const active = this.state.connections.has(s.id) ? '🟢' : '⚪';
          const summary = summaries.get(s.path) || '无摘要';
          const alias = sessionToAlias.get(s.id);
          const aliasTag = alias ? ` @${alias}` : '';
          const time = new Date(s.modified).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' });
          return `${active} **${name}**${aliasTag}\n   ${summary}\n   ${time}`;
        }).join('\n\n');
        
        await this.sendText(userId, `**📋 Sessions：**\n\n${sessionList}`);
        break;
      }
      
      case 'alias': {
        const [name, targetSession] = args.split(/\s+/);
        if (!name) {
          // 列出别名（从 session 文件中读取）
          const { listSessions } = await import('./session-discover.js');
          const sessions = listSessions();
          const aliases = await this.getAliases();
          
          if (Object.keys(aliases).length === 0) {
            await this.sendText(userId, 'ℹ️ **没有设置别名**\n\n使用 /alias <名称> 设置别名');
          } else {
            const aliasList = Object.entries(aliases).map(([k, v]) => `- @${k}`).join('\n');
            await this.sendText(userId, `**📋 别名列表：**\n\n${aliasList}`);
          }
        } else if (!targetSession) {
          // 设置当前 session 别名
          const currentSession = this.state.defaultSessionId;
          if (!currentSession) {
            await this.sendText(userId, '❌ 没有当前 session，请先启动 pi');
          } else {
            await this.setAlias(name, currentSession);
            await this.sendText(userId, `✅ 已设置别名：\n- @${name} → ${currentSession.slice(0, 8)}...`);
          }
        } else {
          // 设置指定 session 别名（支持短 ID 匹配）
          const { listSessions } = await import('./session-discover.js');
          const sessions = listSessions();
          const matchedSession = sessions.find(s => s.id.startsWith(targetSession));
          
          if (!matchedSession) {
            await this.sendText(userId, `❌ 未找到 session: ${targetSession}`);
            break;
          }
          
          // 存储完整的 session ID
          await this.setAlias(name, matchedSession.id);
          await this.sendText(userId, `✅ 已设置别名：\n- @${name} → ${matchedSession.id.slice(0, 8)}...`);
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
        // 创建新 session + 打开 Ghostty
        const { spawn } = await import('node:child_process');
        const { homedir } = await import('node:os');
        
        // 解析参数：/new [别名] [/path/to/project] [消息]
        let projectPath = homedir();
        let aliasName = '';
        let message = '';
        
        if (args) {
          const parts = args.split(/\s+/);
          
          // 解析参数：/new [/path] [名称] [消息]
          let i = 0;
          
          // 1. 检查是否有路径
          if (i < parts.length && parts[i].startsWith('/')) {
            projectPath = parts[i];
            i++;
          }
          
          // 2. 剩余参数：第一个是名称（如果有多个），其他是消息
          const remaining = parts.slice(i);
          if (remaining.length === 0) {
            // 没有参数，默认消息
            message = '来自微信';
          } else if (remaining.length === 1) {
            // 只有一个参数，是消息
            message = remaining[0];
          } else {
            // 多个参数：第一个是名称，其他是消息
            aliasName = remaining[0];
            message = remaining.slice(1).join(' ');
          }
        } else {
          message = '来自微信';
        }
        
        // 如果没有消息，使用默认消息
        if (!message) {
          message = '来自微信';
        }
        
        // 创建启动脚本（让 pi 自己创建 session）
        const { writeFileSync, chmodSync } = await import('node:fs');
        const { join } = await import('node:path');
        const scriptPath = join(projectPath, '.pi-start.sh');
        
        // 使用 --name 参数设置 session 名称，pi 会自动创建 session
        const sessionName = aliasName || `wechat-${Date.now()}`;
        const scriptContent = `#!/bin/bash\ncd "${projectPath}" 2>&1 || { echo "目录不存在: ${projectPath}"; read; exit 1; }\npi --name "${sessionName}" --approve 2>&1 || { echo \"pi 启动失败\"; read; }\n`;
        writeFileSync(scriptPath, scriptContent, 'utf-8');
        chmodSync(scriptPath, '755');
        
        console.log(`[微信] 启动脚本: ${scriptPath}`);
        console.log(`[微信] 脚本内容:\n${scriptContent}`);
        
        // 消息入队，key 为 sessionName（确保发给正确的 pi）
        const pendingKey = sessionName;
        if (!this.state.pendingNewMessages.has(pendingKey)) {
          this.state.pendingNewMessages.set(pendingKey, []);
        }
        this.state.pendingNewMessages.get(pendingKey)!.push({
          id: `msg_${Date.now()}`,
          sessionId: '__pending__',
          userId: userId,
          text: message,
          images: [],
          timestamp: Date.now(),
          retries: 0,
        });
        
        this.state.pendingNewSession = true;
        
        // 启动终端 + pi
        const child = await this.spawnTerminal(scriptPath);
        child.unref();
        
        // 10s 超时检测
        const timer = setTimeout(() => {
          if (this.state.pendingNewMessages.has(pendingKey)) {
            this.state.pendingNewMessages.delete(pendingKey);
            console.log(`[微信] /new 超时: ${pendingKey}`);
            if (this.state.pendingNewMessages.size === 0) {
              this.state.pendingNewSession = false;
            }
            this.sendText(userId, `⏰ 创建 pi 超时（10s），请检查终端窗口`).catch(() => {});
          }
          this.state.pendingNewTimers.delete(pendingKey);
        }, 10000);
        this.state.pendingNewTimers.set(pendingKey, timer);
        
        // 发送启动消息
        await this.sendText(userId, `⏳ 正在启动 pi...`);
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
          await this.sendText(userId, `❌ session ${targetSessionId.slice(0, 8)}... 未连接`);
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
          await this.sendText(userId, `❌ session ${targetSessionId.slice(0, 8)}... 未连接`);
          break;
        }
        
        this.state.sendToSession(targetSessionId, 'wechat_command', { command: 'stop', userId });
        break;
      }
      
      case 'kill': {
        // 强制终止 pi 进程（支持 /kill 或 /kill <name|id>）
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
        
        const conn = this.state.connections.get(targetSessionId);
        if (!conn) {
          await this.sendText(userId, `❌ session ${targetSessionId.slice(0, 8)}... 未连接`);
          break;
        }
        
        try {
          process.kill(conn.pid, 'SIGTERM');
          
          // 切换到其他活跃 session，避免自动重启
          const isDefault = targetSessionId === this.state.defaultSessionId;
          if (isDefault) {
            // 找其他活跃 session
            const otherSession = Array.from(this.state.connections.entries())
              .find(([id, c]) => id !== targetSessionId && c.socket.writable);
            
            if (otherSession) {
              this.state.defaultSessionId = otherSession[0];
              await this.sendText(userId, `🛑 已终止 ${targetSessionId.slice(0, 8)}...，已切换到 ${otherSession[0].slice(0, 8)}...`);
            } else {
              this.state.defaultSessionId = null;
              await this.sendText(userId, `🛑 已终止 ${targetSessionId.slice(0, 8)}...，无其他活跃 session`);
            }
          } else {
            await this.sendText(userId, `🛑 已终止 ${targetSessionId.slice(0, 8)}...`);
          }
        } catch (e: any) {
          await this.sendText(userId, `❌ 终止失败: ${e.message}`);
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
          await this.sendText(userId, `❌ session ${targetSessionId.slice(0, 8)}... 未连接`);
          break;
        }
        
        const sessionName = targetSessionId.slice(0, 8);
        const isDefault = targetSessionId === this.state.defaultSessionId;
        const progress = this.state.getProgress(targetSessionId);
        
        // 计算最后活跃时间
        const lastActive = conn.lastHeartbeat;
        const timeSinceLastActive = Date.now() - lastActive.getTime();
        const lastActiveText = timeSinceLastActive < 60000 ? '刚刚' : 
          timeSinceLastActive < 3600000 ? `${Math.floor(timeSinceLastActive / 60000)} 分钟前` : 
          `${Math.floor(timeSinceLastActive / 3600000)} 小时前`;
        
        // 判断状态
        let statusEmoji = '🟢';
        let statusText = '运行中';
        if (timeSinceLastActive > 300000) { // 5 分钟
          statusEmoji = '⚠️';
          statusText = '可能卡死';
        } else if (timeSinceLastActive > 60000) { // 1 分钟
          statusEmoji = '⏸️';
          statusText = '可能暂停';
        }
        
        let progressText = `**📊 @${sessionName}：**\n\n`;
        progressText += `- 状态：${statusEmoji} ${statusText}\n`;
        
        if (progress.startTime) {
          const runtime = Math.floor((Date.now() - progress.startTime) / 1000);
          const runtimeText = runtime > 60 ? `${Math.floor(runtime / 60)} 分钟` : `${runtime} 秒`;
          progressText += `- 已运行：${runtimeText}\n`;
        }
        
        progressText += `- 最后活跃：${lastActiveText}\n`;
        
        if (isDefault) {
          progressText += `- 标记：⭐ 默认 session\n`;
        }
        
        // 显示进度消息历史
        if (progress.messages.length > 0) {
          progressText += `\n**进度历史：**\n`;
          progress.messages.forEach((msg, i) => {
            progressText += `${i + 1}. ${msg}\n`;
          });
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
        // 切换 session（支持 ID、短 ID、名称）
        const { listSessions } = await import('./session-discover.js');
        const sessions = listSessions();
        
        if (!args) {
          await this.sendText(userId, '❌ 请指定 session id 或名称\n\n用法: /switch <session-id 或名称>');
          break;
        }
        
        // 优先通过 ID 或短 ID 查找
        let targetSession = sessions.find(s => s.id.startsWith(args));
        
        // 如果没找到，通过名称查找
        if (!targetSession) {
          targetSession = sessions.find(s => s.name && s.name.toLowerCase().includes(args.toLowerCase()));
        }
        
        if (!targetSession) {
          await this.sendText(userId, `❌ 未找到 session: ${args}`);
          break;
        }
        
        // 检查目标 session 是否有 pi 连接
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
  
  // 获取别名（从 session 文件中读取）
  private async getAliases(): Promise<Record<string, string>> {
    const { listSessions } = await import('./session-discover.js');
    const sessions = listSessions();
    
    // 从 session 文件中读取 name，构建别名映射
    const aliases: Record<string, string> = {};
    for (const session of sessions) {
      if (session.name) {
        aliases[session.name] = session.id;
      }
    }
    
    return aliases;
  }
  
  // 根据 ID 或短 ID 查找 session
  private async findSessionById(id: string): Promise<string | null> {
    // 1. 检查是否是完整的 session ID
    if (this.state.connections.has(id)) {
      return id;
    }
    
    // 2. 检查是否是短 ID（前缀匹配）
    for (const connId of this.state.connections.keys()) {
      if (connId.startsWith(id)) {
        return connId;
      }
    }
    
    // 3. 通过 name 查找
    const { listSessions } = await import('./session-discover.js');
    const sessions = listSessions();
    const session = sessions.find((s: any) => s.name && s.name.toLowerCase().includes(id.toLowerCase()));
    return session ? session.id : null;
  }
  
  // 设置别名（更新 session 文件中的 name）
  private async setAlias(name: string, sessionId: string): Promise<void> {
    // 这里我们需要更新 session 文件中的 name
    // 暂时先保存到 config 中，后续再优化
    const { saveAliases } = await import('./config.js');
    const aliases = await this.getAliases();
    aliases[name] = sessionId;
    saveAliases(aliases);
  }
  
  // 路由消息到正确的 session
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
  // 打开终端窗口（优先 Ghostty，回退 Terminal.app）
  private async spawnTerminal(scriptPath: string) {
    const { spawn, execSync } = await import('node:child_process');
    
    // 检测 Ghostty
    try {
      execSync('ls /Applications/Ghostty.app > /dev/null 2>&1');
      return spawn('open', ['-na', 'Ghostty.app', '--args', '-e', scriptPath], { detached: true, stdio: 'ignore' });
    } catch {}
    
    // 回退 Terminal.app
    return spawn('open', ['-a', 'Terminal.app', scriptPath], { detached: true, stdio: 'ignore' });
  }
  
  // 自动启动 pi session（--no-session 模式）
  private async spawnPiSession(sessionId: string): Promise<boolean> {
    try {
      const { spawn } = await import('node:child_process');
      
      // 获取 session 的 cwd
      const { getSession } = await import('./session-discover.js');
      const session = getSession(sessionId);
      const cwd = session?.cwd || process.env.HOME || '/tmp';
      
      console.log(`[微信] 启动 pi: session=${sessionId.slice(0, 8)}, cwd=${cwd}`);
      
      // 创建启动脚本（使用 --session-id 和 cd）
      const { writeFileSync, chmodSync } = await import('node:fs');
      const { join } = await import('node:path');
      const scriptPath = join(cwd, '.pi-start.sh');
      const scriptContent = `#!/bin/bash\ncd "${cwd}" 2>&1 || { echo "目录不存在: ${cwd}"; read; exit 1; }\npi --session-id "${sessionId}" --approve 2>&1 || { echo \"pi 启动失败\"; read; }\n`;
      writeFileSync(scriptPath, scriptContent, 'utf-8');
      chmodSync(scriptPath, '755');
      
      console.log(`[微信] 启动脚本: ${scriptPath}`);
      
      // 在 Ghostty 中启动 pi
      const child = spawn('open', [
        '-na', 'Ghostty.app',
        '--args',
        '-e', scriptPath
      ], {
        detached: true,
        stdio: 'ignore',
      });
      
      child.unref();
      
      console.log(`[微信] pi 已启动: session=${sessionId.slice(0, 8)}`);
      return true;
    } catch (e) {
      console.error('[微信] 启动 pi 失败:', e);
      return false;
    }
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
