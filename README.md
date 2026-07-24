# 📱 pi-wechat-manager

> 微信控制 pi（AI 编程助手）的专属插件 —— 多个 pi 同时工作，一个微信全搞定。

---

## 快速开始

### 安装

```bash
# 安装插件
pi install git:github.com/baihuibo/pi-wechat-manager@main

# 截屏功能依赖（可选，不需要截屏可跳过）
npm install -g playwright
playwright install chromium
```

### 启动

在 pi 中执行：

```bash
/wechat start
```

---

## 命令速查

> `[唯一标识]` = 别名 或 sessionId（支持短 id 前缀匹配）

### 💬 消息

| 命令 | 说明 |
|------|------|
| 直接发消息 | 发给默认 pi |
| `@[唯一标识] 消息` | 发给指定 pi |

### 📂 Session

| 命令 | 说明 |
|------|------|
| `/new` | 新建 pi |
| `/new [唯一标识] [消息]` | 新建 pi，指定名字和首条消息 |
| `/new /path [唯一标识] [消息]` | 指定目录创建 |
| `/switch [唯一标识]` | 切换默认 pi |
| `/sessions` | 列出所有 pi |

### 🎛️ 控制

| 命令 | 说明 |
|------|------|
| `/stop` | 中断当前操作 |
| `/stop [唯一标识]` | 中断指定 pi |
| `/kill` | 终止当前 pi 进程 |
| `/kill [唯一标识]` | 终止指定 pi |
| `/progress` | 查看任务进度 |
| `/progress [唯一标识]` | 查看指定 pi 进度 |

### 🤖 AI

| 命令 | 说明 |
|------|------|
| `/model` | 列出模型 |
| `/model [模型名]` | 切换模型 |
| `/context` | 查询上下文用量 |
| `/compact` | 压缩上下文 |

### 🏷️ 别名

| 命令 | 说明 |
|------|------|
| `/alias` | 列出别名 |
| `/alias [名字]` | 给当前 pi 起名 |

### ⏰ 定时

| 命令 | 说明 |
|------|------|
| `/cron` | 查看定时任务 |
| `/cron [名字]` | 查看详情 |
| `/cron remove [名字]` | 删除 |

### 📊 其他

| 命令 | 说明 |
|------|------|
| `/status` | 连接状态 |
| `/help` | 显示帮助 |

---

## pi 端命令

| 命令 | 说明 |
|------|------|
| `/wechat start` | 连接微信（守护进程自动持久运行） |
| `/wechat stop` | 断开微信 |
| `/wechat status` | 查看桥接状态 |
| `/wechat sessions` | 列出所有 pi 会话 |
| `/wechat alias` | 查看当前别名 |
| `/wechat alias [名字]` | 给自己起名 |

---

## 使用示例

```
# 创建两个 pi 各干各的
/new 酒店 帮我改登录模块
/new 前端 帮我调首页接口

# 分别对话
@酒店 刚才改的回滚一下
@前端 接口文档发我

# 切到酒店（之后不用打 @）
/switch 酒店
帮我加一个注册接口

# 查看进度
/progress 前端

# 停了前端（通过短 id 也行）
/stop abc1234

# 清理
/kill 前端
```

---

## 特别功能

### 📸 截屏

在微信对 pi 说自然语言：

```
截屏看看桌面
打开百度搜AI然后截屏
```

### ⏰ 定时任务

```
5分钟后提醒我开会
每天早上9点汇报系统状态
```

### 🎙️ 语音消息

直接发微信语音，pi 自动转文字并回复。

---

## 工作原理

```
微信消息 → 守护进程(常驻后台) → 路由到对应 pi → pi 处理 → 回复到微信
                                        ↑
                              多个 pi 同时连接
```

- **守护进程**：独立于 pi 运行，微信消息的中转站
- **pi 扩展**：每个 pi 窗口自动连接守护进程
- **端口**：19087（HTTP API，调试用）

---

## 更新

```bash
cd ~/.pi/agent/git/github.com/baihuibo/pi-wechat-manager
git pull
```

然后在 pi 中 `/reload`。

---

## 依赖

| 依赖 | 必需 | 说明 |
|------|------|------|
| Node.js ≥ 18 | ✅ | |
| [pi](https://github.com/earendil-works/pi-coding-agent) | ✅ | |
| macOS | ✅ | |
| Ghostty（可选） | ❌ | `/new` 用，无则回退 Terminal.app |
| Playwright（可选） | ❌ | 网页截屏用，无则仅桌面截屏 |

---

## License

MIT
