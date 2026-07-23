# 📱 pi-wechat-manager

> 微信控制 pi（AI 编程助手）的专属插件 —— 多个 pi 同时工作，一个微信全搞定。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**在微信上指挥 pi 写代码、截图、定时任务，甚至从被窝里让它帮你干活。**

---

## 快速开始

### 安装

```bash
# npm 安装到 pi 全局扩展
npm install -g pi-wechat-manager

# 或手动克隆
git clone https://github.com/baihuibo/pi-wechat-manager ~/.pi/agent/extensions/pi-wechat-manager
```

### 启动

在 pi 中执行：

```bash
/wechat start
```

首次使用会显示二维码，用微信扫码登录。之后每次 `/wechat start` 自动连上，无需重复扫码。

---

## 微信端使用

扫码后在微信中直接发消息即可与 pi 对话。也支持丰富的命令：

| 命令 | 说明 |
|------|------|
| `/new` | 创建新 pi 窗口 + 发送消息 |
| `/new 你好` | 创建新 pi，消息"你好" |
| `/new 酒店 你好` | 创建新 pi，名称"酒店"，消息"你好" |
| `/new /path/to 酒店 你好` | 在指定路径创建 |
| `/switch 酒店` | 切换到指定 pi |
| `/stop` / `/stop 酒店` | 停止当前/指定 pi |
| `/kill` / `/kill 酒店` | 终止当前/指定 pi |
| `/progress` | 查询任务进度 |
| `/reset` | 清空上下文 |
| `/alias 酒店` | 给当前 pi 起名字 |
| `@酒店 消息` | 发消息给指定 pi |
| `/status` / `/help` | 查看状态/帮助 |

---

## pi 端命令

| 命令 | 说明 |
|------|------|
| `/wechat start` | 连接微信（守护进程自动持久运行） |
| `/wechat stop` | 断开微信（唯一停止方式） |
| `/wechat status` | 查看桥接状态 |
| `/wechat sessions` | 列出所有 pi 会话 |
| `/wechat alias` | 管理名称 |

---

## 特别功能

### 📸 截屏

在微信对 pi 说**自然语言**就行：

```
截屏看看桌面
截屏看看百度
打开百度搜AI然后截屏
```

### ⏰ 定时任务

AI 帮你管理，直接说人话：

```
5分钟后提醒我开会
每天早上9点汇报系统状态
每30分钟检查服务状态
```

### 📊 进度通知

长任务时 pi 自动推送进度，微信上实时看到：

```
⏳ @酒店: 调研完成，正在分析...（已运行 2 分钟）
✅ @酒店: 任务完成（共耗时 8 分钟）
```

### 🎙️ 语音消息

直接发微信语音，pi 自动转文字并回复。

### 🖥️ 多 pi 并行

一个微信同时控制多个 pi，每个 pi 独立工作：

```
@酒店 帮我改登录模块
@小程序 帮我调首页接口
```

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

## 常见问题

**Q: 换电脑或重启后需要重新扫码吗？**

A: 不需要，凭证自动保存。

**Q: 怎么关闭？**

A: pi 中执行 `/wechat stop`。

**Q: 守护进程会自己关吗？**

A: 不会，start 即持久，只有 stop 能关。

**Q: 微信发消息没反应？**

A: 执行 `/wechat start` 让当前 pi 连上守护进程。守护进程一直跑着呢。

---

## 依赖

| 依赖 | 必需 | 说明 |
|------|------|------|
| Node.js ≥ 18 | ✅ | |
| [pi](https://github.com/earendil-works/pi-coding-agent) ≥ 0.81 | ✅ | |
| macOS | ✅ | |
| Ghostty（可选） | ❌ | `/new` 命令使用，无则回退 Terminal.app |
| Playwright（可选） | ❌ | 网页截屏使用，无则仅支持桌面截屏 |

---

## License

MIT
