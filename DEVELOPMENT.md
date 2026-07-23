# pi-wechat-manager 开发文档

> 最后更新：2026-07-23

## 项目概述

pi-wechat-manager 是一个 pi 扩展，实现微信与 pi 的双向通信。

**核心特点**：
- 守护进程默认持久运行（start 即持久，只有 stop 可停止）
- 多 session 管理 + 别名路由
- 自然语言定时任务
- Ghostty 窗口唤醒
- HTTP API 端口 19087

---

## 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│  macOS LaunchAgent（可选）                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  守护进程 (daemon.ts)                                  │  │
│  │  ├── WeChat iLink 客户端（微信通信）                    │  │
│  │  ├── Socket Server（pi 扩展连接）                      │  │
│  │  ├── HTTP Server（API 接口，端口 19087）                │  │
│  │  ├── 消息队列                                          │  │
│  │  └── Session 管理器                                    │  │
│  └───────────────────────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────┘
                             │ Unix Socket
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
   │ pi A    │          │ pi B    │          │ 调试工具 │
   │ 扩展    │          │ 扩展    │          │ API 接口 │
   └─────────┘          └─────────┘          └─────────┘
```

### 文件结构

```
~/.pi/agent/extensions/pi-wechat-manager/
├── index.ts                 # pi 扩展入口
├── src/
│   ├── daemon.ts            # 守护进程主程序
│   ├── daemon-state.ts      # 状态管理
│   ├── config.ts            # 配置管理
│   ├── session-discover.ts  # Session 发现
│   ├── wechat-bridge.ts     # 微信桥接层
│   ├── wechat-client.ts     # iLink 客户端（从 pi-wechat-assistant 提取）
│   ├── wechat-auth.ts       # 认证管理
│   ├── wechat-api.ts        # API 调用
│   ├── llm-summarizer.ts    # LLM 摘要服务
│   └── ...                  # 其他辅助模块
├── package.json
└── README.md

~/.pi/agent/pi-wechat-manager/  （运行时数据）
├── credentials.json         # 微信凭证
├── aliases.json             # 别名映射
├── config.json              # 配置
├── daemon.sock              # Socket 文件
├── daemon.pid               # 进程 PID
├── daemon.log               # 日志
└── queue/                   # 消息队列

API 接口（端口 19087）：
- GET /api/status          - 守护进程状态
- GET /api/sessions        - Session 列表
- GET /api/aliases         - 别名列表
- GET /api/wechat/status   - 微信状态
```

---

## 功能清单

### ✅ 已实现

#### 1. 守护进程

| 功能 | 说明 | 状态 |
|------|------|------|
| Socket 服务器 | pi 扩展通过 Unix Socket 连接 | ✅ |
| HTTP 服务器 | API 接口（端口 19087） | ✅ |
| 消息队列 | pi 未连接时缓存消息 | ✅ |
| 心跳检测 | 30 秒间隔，60 秒超时 | ✅ |
| 自动关闭 | 无连接且未设置 keep 时，直接关闭 | ✅ |

#### 2. 微信桥接

| 功能 | 说明 | 状态 |
|------|------|------|
| iLink 协议 | 微信 Bot API 通信 | ✅ |
| 消息接收 | 文本、图片、语音、文件 | ✅ |
| 消息路由 | 默认 session + @别名路由 | ✅ |
| 命令处理 | /help, /status, /sessions 等 | ✅ |
| 自动启动 pi | 无连接时自动启动 pi（Ghostty 模式） | ✅ |
| 输入状态 | "对方正在输入..." 状态 | ✅ |
| 非阻塞处理 | 消息并行处理，不阻塞 | ✅ |

#### 3. pi 扩展命令

| 命令 | 说明 | 状态 |
|------|------|------|
| `/wechat start` | 启动守护进程 + 登录微信 | ✅ |
| `/wechat keep` | 设置持久模式（pi 退出后继续运行） | ✅ |
| `/wechat stop` | 停止守护进程并退出登录 | ✅ |
| `/wechat status` | 查看状态 | ✅ |
| `/wechat sessions` | 列出 sessions（最近 20 个，活跃前置） | ✅ |
| `/wechat alias` | 管理别名 | ✅ |

#### 4. 消息同步

| 功能 | 说明 | 状态 |
|------|------|------|
| 微信→pi | 带 `[微信消息]` 前缀标识 | ✅ |
| pi→微信 | 监听 message_end 事件，带 session 名称前缀 | ✅ |
| 系统提示词注入 | 告诉 AI 当前通过微信交互 | ✅ |
| 欢迎消息 | 首次消息发送精简帮助 | ✅ |
| 输入状态 | "对方正在输入..." 状态 | ✅ |
| 多 session 并行 | 多个 pi 同时工作 | ✅ |

#### 5. 图片/文件发送

| 工具 | 说明 | 状态 |
|------|------|------|
| `send_file_to_wechat` | 发送项目目录中的文件 | ✅ 已验证 |
| `send_image_to_wechat` | 发送项目目录中的图片 | ✅ 已验证 |

#### 6. 实时状态推送

| 事件 | 推送内容 | 状态 |
|------|----------|------|
| `agent_start` | 发送"正在输入..."状态 | ✅ 已验证 |
| `message_end` | 回复内容（带 session 名称前缀） | ✅ 已验证 |
| `agent_end` | 任务完成通知（带耗时） | ✅ |

#### 7. Session 管理

| 功能 | 说明 | 状态 |
|------|------|------|
| Session 发现 | 读取 `~/.pi/agent/sessions/` 目录 | ✅ |
| LLM 摘要 | 使用 DeepSeek-v4-flash 生成摘要 | ✅ |
| 活跃 session 前置 | 有 pi 连接的 session 排在前面 | ✅ |
| 完整 session ID | 显示完整 ID 便于操作 | ✅ |
| 多 session 并行 | 多个 pi 同时工作 | ✅ 已验证 |

#### 8. 别名系统

| 功能 | 说明 | 状态 |
|------|------|------|
| 设置别名 | `/wechat alias 酒店 <session-id>` | ✅ |
| 别名路由 | `@酒店 消息` 自动路由到对应 session | ✅ 已验证 |
| 短 ID 匹配 | 支持短 ID 匹配 | ✅ |
| 持久化 | 保存到 `~/.pi/agent/pi-wechat-manager/aliases.json` | ✅ |

---

## 参考项目

### 1. pi-wechat-assistant

**来源**：`npm:pi-wechat-assistant`

**核心功能**：
- 微信作为 pi TUI 的移动端分身
- 双向消息同步
- 图片/文件/语音支持
- 消息队列和批量合并
- 排他锁防止多实例冲突

**我们借鉴的部分**：
- iLink 协议客户端（`wechat-client.ts`）
- 认证管理（`wechat-auth.ts`）
- QR 码登录流程
- 消息分块发送

**我们改进的部分**：
- 支持多 session（原版只支持一对一）
- 支持别名路由
- 支持远程 session 切换
- 独立守护进程（原版依赖 pi 生命周期）

### 2. pi-weixinbot

**来源**：`npm:pi-weixinbot`

**核心功能**：
- 最简微信机器人
- 扫码登录
- 消息收发
- 多账户支持

**未采用原因**：功能过于简单，不支持图片/文件。

### 3. @yansircc/pi-weixin

**来源**：`npm:@yansircc/pi-weixin`

**核心功能**：
- 基于 pipee 框架
- 多 session 路由（引用消息路由到特定 session）
- Web Surface 界面

**未采用原因**：强依赖 pipee 框架，标准 pi 无法使用。

### 4. claude-codex-wechat

**来源**：`npm:claude-codex-wechat`

**核心功能**：
- 遥控 Claude Code 和 Codex CLI
- 独立守护进程
- Web 管理界面
- 多会话支持

**参考价值**：架构设计（独立进程 + Socket 通信）。

---

## 状态管理

### 状态定义

```typescript
enum WechatState {
  IDLE = 'IDLE',                          // 未连接守护进程
  DAEMON_CONNECTED = 'DAEMON_CONNECTED',  // 守护进程已连接，微信未登录
  WECHAT_LOGGED_IN = 'WECHAT_LOGGED_IN',  // 微信已登录，等待连接
  WECHAT_CONNECTED = 'WECHAT_CONNECTED',  // 微信完全连接
}
```

### 状态栏显示

| 状态 | 状态栏 |
|------|--------|
| IDLE | （空） |
| DAEMON_CONNECTED | （空） |
| WECHAT_LOGGED_IN | `微信已登录` |
| WECHAT_CONNECTED | `微信已连接` |
| WECHAT_CONNECTED + keep | `微信已连接 - 守护进程已启动` |

### 生命周期

```
/wechat start
  │
  ├─ 守护进程已运行？→ 直接连接
  │
  └─ 守护进程未运行？→ 启动 → 连接 → 检查登录
      │
      ├─ 已登录 → 状态：WECHAT_CONNECTED
      │
      └─ 未登录 → 显示二维码 → 扫码 → 状态：WECHAT_CONNECTED

/wechat keep
  │
  └─ 设置 persist=true → 守护进程不随 pi 退出

pi 退出
  │
  ├─ persist=true → 守护进程继续运行
  │
  └─ persist=false → 30 秒后自动关闭
```

---

## 待实现功能

### ⚠️ 重要约束

**所有微信专属功能必须满足启用条件**：
- 微信已连接（`currentState === WechatState.WECHAT_CONNECTED`）
- 有微信用户（`lastWechatUser !== null`）

**不满足条件时**：
- 工具不可用
- 命令不响应
- 不发送任何消息

### P0 - 高优先级

| 功能 | 说明 | 状态 |
|------|------|------|
| **LaunchAgent** | macOS 系统级自启动 | 待实现 |
| **任务进度通知** | 长任务关键节点通知 | ✅ 已完成 |
| **进度查询** | 微信查询活跃 session 状态 | ✅ 已完成 |
| **紧急停止** | /kill 命令，强制终止 pi 进程 | ✅ 已完成 |
| **创建新 session** | /new 命令，创建新 pi + 打开 Ghostty | ✅ 已完成 |
| **清空上下文** | /reset 命令，清空 session 上下文 | ✅ 已完成 |
| **Ghostty 唤醒** | 所有用户 session 在 Ghostty 中打开 | ✅ 已完成 |

**注**：
- 流式输出已通过 `wechat_notify_progress` 工具实现（进度提示代替流式输出）
- Web UI 已移除，保留 API 接口（端口 19087）

#### 任务进度通知设计

**方案：pi 主动通知（wechat_notify_progress 工具）**

1. 注册 `wechat_notify_progress` 工具，仅在微信连接时可用
2. 系统提示词告知 pi：长任务时在关键节点调用此工具
3. 短任务不要使用，避免过度打扰

**触发条件**：
- 微信已连接（`wechatConversationActive = true`）
- 任务预计耗时 > 1 分钟

**通知节点示例**：
- 调研完成 → “🔍 调研完成，正在分析...”
- 分析完成 → “📊 分析完成，开始写代码...”
- 代码生成 → “💻 代码已生成，正在测试...”
- 遇到问题 → “⚠️ 遇到问题：xxx”

**消息格式**：
```
⏳ @session名称: 进度描述（已运行 3 分钟）
```

**系统提示词规则**：
```
如果当前任务比较复杂（预计超过1分钟），可以在关键节点调用 wechat_notify_progress 工具通知用户进度：
- 调研完成后
- 分析完成后
- 代码生成后
- 遇到重要问题时

注意：短任务不要使用，避免过度打扰用户。
```

### P1 - 中优先级

| 功能 | 说明 | 状态 |
|------|------|------|
| **语音消息** | 微信语音转文字后发送给 pi | ✅ 已验证 |
| **截屏能力** | pi 截屏发送到微信（npx playwright） | ✅ 已验证 |
| **定时任务** | 定时执行任务并汇报 | ✅ 已完成 |
| **多 session 并行** | 多个 pi 同时工作 | ✅ 已验证 |
| **输入状态** | "对方正在输入..." 状态 | ✅ 已验证 |
| **非阻塞处理** | 消息并行处理，不阻塞 | ✅ 已验证 |

#### 进度查询设计

**方案：从守护进程读取已上报的进度（不打扰 pi）**

**触发方式**：
- `/progress` - 查询当前默认 session 的进度
- `@别名 /progress` - 查询指定 session 的进度

**实现**：
1. pi 调用 `wechat_notify_progress` 上报进度时，守护进程记录
2. 用户查询时，守护进程返回已记录的进度历史
3. 不会打扰正在忙碌的 pi

**存储结构**：
```typescript
interface SessionProgress {
  sessionId: string;
  startTime: number;        // 任务开始时间
  lastUpdate: number;       // 最后更新时间
  messages: string[];       // 进度消息列表
  status: 'running' | 'completed' | 'failed';
}
```

**查询结果示例**：
```
📊 @酒店：
- 状态：⏳ 运行中
- 已运行：8 分钟
- 进度：
  1. 🔍 调研完成（6 分钟前）
  2. 📊 分析完成（3 分钟前）
  3. 💻 正在写代码...
```

---

## 待设计功能

### 1. 语音消息支持

**流程**：
- 用户发语音 → 微信 API 转文字 → 发给 pi
- pi 回复文字 → 可选转语音发给用户

**价值**：开车、走路时也能用

### 2. 截屏能力

**设计思路**：自然语言描述，AI 自己判断用什么方式截屏

**工具设计**：
```typescript
pi.registerTool({
  name: 'wechat_screenshot',
  description: '截屏并发送到微信',
  parameters: {
    instruction: string  // 自然语言描述
  },
  execute: async (params) => {
    // 1. 截屏（AI决定用系统命令还是 Playwright）
    const screenshotPath = await takeScreenshot(params.instruction);
    
    // 2. 发送到微信
    await sendImageToWechat(screenshotPath);
    
    return { content: [{ type: 'text', text: '✅ 截图已发送' }] };
  }
})
```

**使用场景**：
| 用户说 | AI 做 |
|--------|-------|
| 截屏看看桌面 | 系统截屏 |
| 截屏看看终端 | 窗口截屏 |
| 截屏看看百度 | Playwright 截屏 |
| 打开百度搜AI然后截屏 | Playwright 脚本 + 截屏 |

**系统提示词**：
```
你可以使用 wechat_screenshot 工具截屏：

直接描述你想看什么，比如：
- 截屏看看桌面
- 截屏看看终端
- 截屏看看百度
- 打开百度搜 AI 然后截屏
```

### 3. 定时任务

**设计思路**：自然语言交互，无需记命令

**交互流程**：
```
用户：你每天早上9点汇报系统状态

pi：好的，我帮你设置定时任务：
    ⏰ 每天早上 9:00
    📋 汇报系统状态
    确认添加吗？

用户：确认

pi：✅ 定时任务已添加
```

**执行流程**：
1. 守护进程按时间触发任务
2. 发送消息给 pi：执行定时任务「xxx」
3. pi 执行任务，结果通知微信
4. 失败也通知

**边界情况**：
| 情况 | 处理 |
|------|------|
| 电脑睡着 | 任务跳过，醒来后不补执行 |
| pi 未连接 | 任务跳过，记录日志 |
| 任务失败 | 微信通知失败原因 |
| 用户确认前 | 不执行，等待确认 |

**存储结构**：
```typescript
interface CronTask {
  id: string;
  schedule: string;       // 原始自然语言
  cron: string;           // 转换后的 cron 表达式
  task: string;           // 任务描述
  sessionId: string;      // 执行的 session
  status: 'pending' | 'confirmed' | 'running';
  createdAt: number;
  lastRun?: number;
  nextRun?: number;
}
```

**输出格式规范**：
```
⏰ 定时任务「汇报系统状态」

📊 系统状态（2024-01-15 09:00）：
- CPU：45%
- 内存：8.2G/16G（51%）
- 磁盘：120G/500G（24%）
- 运行时间：3天2小时

✅ 状态正常
```

**格式规则**：
1. 开头用 ⏰ 标识这是定时任务
2. 用 emoji 分隔不同部分
3. 关键数据用列表展示
4. 异常情况用 ⚠️ 标注
5. 结尾用 ✅ 或 ❌ 表示状态
6. 保持简洁，不超过 15 行

**失败通知示例**：
```
⏰ 定时任务「汇报系统状态」

❌ 执行失败：无法连接到数据库

错误详情：Connection refused
```

---

## 技术细节

### Socket 协议

```typescript
// 请求
interface SocketRequest {
  id: string;
  method: string;
  params: unknown;
}

// 响应
interface SocketResponse {
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

// 事件推送（无 id）
interface SocketEvent {
  event: string;
  data: unknown;
}
```

### 主要 Socket 方法

| 方法 | 方向 | 说明 |
|------|------|------|
| `register` | pi→daemon | 注册 session |
| `unregister` | pi→daemon | 注销 session |
| `heartbeat` | pi→daemon | 心跳 |
| `get_status` | pi→daemon | 获取状态 |
| `send_to_wechat` | pi→daemon | 发送消息到微信 |
| `wechat_message` | daemon→pi | 微信消息到达 |
| `wechat_command` | daemon→pi | 微信命令到达 |

### 微信命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/status` | 查看状态 |
| `/sessions` | 列出 sessions |
| `/new` | 创建新 session + 打开 Ghostty |
| `/new /path/to` | 在指定目录创建新 session |
| `/switch <id>` | 切换 session |
| `/reset` | 清空当前 session 上下文 |
| `/reset <name>` | 清空指定 session 上下文 |
| `/alias <名称>` | 设置别名 |
| `/aliases` | 列出别名 |
| `/stop` | 停止当前任务（pi 进程还在） |
| `/kill` | 强制终止 pi 进程（卡死时使用） |
| `/progress` | 查询任务进度 |
| `@别名 /stop` | 停止指定 session 的任务 |
| `@别名 /kill` | 终止指定 session 的 pi |
| `@别名 /progress` | 查询指定 session 的进度 |

### /kill 命令设计

**与 /stop 的区别**：
| 命令 | 行为 | 场景 |
|------|------|------|
| `/stop` | 停止当前任务，pi 进程还在 | 任务跑偏了，想重新来 |
| `/kill` | 终止 pi 进程 | pi 卡死了，需要重启 |

**判断依据**（通过 /progress 的最后活跃时间）：
- 最后活跃 < 1 分钟 → ✅ 正在运行，用 `/stop`
- 最后活跃 1-5 分钟 → ⏸️ 可能暂停，用 `/stop`
- 最后活跃 > 5 分钟 → ⚠️ 可能卡死，用 `/kill`

**消息格式**：
```
/kill           → 终止默认 session
@酒店 /kill     → 终止指定 session
```
| `/stop` | 停止当前操作 |

---

## 已知问题

| 问题 | 说明 | 状态 |
|------|------|------|
| 流式输出 | 微信不支持真正的流式显示 | 待优化 |
| Session 污染 | 内部调用 pi 会创建 session | 已修复（--no-session） |
| Shell 转义 | 特殊字符破坏命令 | 已修复（文件传参） |
| 首次登录消息 | 需要用户先发消息才能回复 | 设计如此 |

---

## 测试方法

### 1. 基础测试

```bash
# 重启 pi
/reload

# 启动微信桥接
/wechat start

# 查看状态
/wechat status

# 列出 sessions
/wechat sessions
```

### 2. 微信端测试

```
/help           # 查看帮助
/status         # 查看状态
/sessions       # 列出 sessions
/switch <id>    # 切换 session
/alias 酒店     # 设置别名
@酒店 消息      # 发送到指定 session
```

### 3. 图片/文件测试

在 pi 中执行：
```
请把 xxx 文件发送到微信
```

pi 会调用 `send_file_to_wechat` 工具。

---

## 配置文件

### ~/.pi/agent/pi-wechat-manager/config.json

```json
{
  "httpPort": 19087,
  "heartbeatIntervalMs": 30000,
  "heartbeatTimeoutMs": 60000,
  "autoSpawnPi": true,
  "maxQueueSize": 1000
}
```

### ~/.pi/agent/pi-wechat-manager/aliases.json

```json
{
  "酒店": "019f84cd-4577-7296-8f2b-3489d3a4145f",
  "小程序": "019f88c0-958c-7be4-83fa-ddcedc2ea478"
}
```

---

## 更新日志

### 2026-07-22

- 初始版本
- 实现守护进程架构
- 实现微信登录流程
- 实现消息双向同步
- 实现 sessions 管理
- 实现别名系统
- 实现图片/文件发送
- 实现实时状态推送
