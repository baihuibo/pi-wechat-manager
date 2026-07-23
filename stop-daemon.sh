#!/bin/bash
# 停止 pi-wechat-manager 守护进程

PID_FILE="$HOME/.pi/agent/pi-wechat-manager/daemon.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "守护进程未运行"
    exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
    echo "正在停止守护进程 (PID: $PID)..."
    kill "$PID"
    rm -f "$PID_FILE"
    echo "守护进程已停止"
else
    echo "守护进程未运行 (PID 文件存在但进程不存在)"
    rm -f "$PID_FILE"
fi
