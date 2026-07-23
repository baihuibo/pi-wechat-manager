#!/bin/bash
# 启动 pi-wechat-manager 守护进程

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_SCRIPT="$SCRIPT_DIR/src/daemon.ts"

# 检查是否已在运行
PID_FILE="$HOME/.pi/agent/pi-wechat-manager/daemon.pid"
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "守护进程已在运行 (PID: $PID)"
        exit 0
    fi
fi

# 确保目录存在
mkdir -p "$HOME/.pi/agent/pi-wechat-manager"

# 启动守护进程
echo "正在启动 pi-wechat-manager 守护进程..."
cd "$SCRIPT_DIR"
node --loader tsx "$DAEMON_SCRIPT" &
DAEMON_PID=$!

echo "守护进程已启动 (PID: $DAEMON_PID)"
echo "Web UI: http://localhost:9800"
echo "Socket: $HOME/.pi/agent/pi-wechat-manager/daemon.sock"
