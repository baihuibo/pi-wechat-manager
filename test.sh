#!/bin/bash
# 测试 pi-wechat-manager 守护进程

echo "====================================="
echo "pi-wechat-manager 测试"
echo "====================================="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 启动守护进程
echo "1. 启动守护进程..."
npx tsx src/daemon.ts > ~/.pi/agent/pi-wechat-manager/daemon.log 2>&1 &
DAEMON_PID=$!
sleep 2

# 检查进程
if kill -0 $DAEMON_PID 2>/dev/null; then
    echo "   ✅ 守护进程已启动 (PID: $DAEMON_PID)"
else
    echo "   ❌ 守护进程启动失败"
    exit 1
fi

# 检查 Socket
if [ -S ~/.pi/agent/pi-wechat-manager/daemon.sock ]; then
    echo "   ✅ Socket 文件已创建"
else
    echo "   ❌ Socket 文件不存在"
fi

# 检查 HTTP
echo ""
echo "2. 测试 HTTP API..."
STATUS=$(curl -s http://localhost:9800/api/status)
if [ $? -eq 0 ]; then
    echo "   ✅ HTTP 服务器响应正常"
    echo "   状态: $STATUS"
else
    echo "   ❌ HTTP 服务器未响应"
fi

# 检查 Sessions
echo ""
echo "3. 测试 Session 发现..."
SESSIONS=$(curl -s http://localhost:9800/api/sessions)
if [ $? -eq 0 ]; then
    SESSION_COUNT=$(echo "$SESSIONS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null)
    echo "   ✅ 发现 $SESSION_COUNT 个 session"
else
    echo "   ❌ 获取 sessions 失败"
fi

# 测试 Socket 连接
echo ""
echo "4. 测试 Socket 连接..."
RESULT=$(node -e "
const net = require('net');
const socket = net.createConnection('$HOME/.pi/agent/pi-wechat-manager/daemon.sock');
socket.on('connect', () => {
  socket.write(JSON.stringify({id:'1',method:'get_status',params:{}})+'\n');
});
socket.on('data', (data) => {
  console.log(data.toString().trim());
  socket.end();
});
setTimeout(() => process.exit(0), 2000);
" 2>/dev/null)
if [ -n "$RESULT" ]; then
    echo "   ✅ Socket 连接正常"
else
    echo "   ❌ Socket 连接失败"
fi

# 清理
echo ""
echo "5. 清理..."
kill $DAEMON_PID 2>/dev/null
rm -f ~/.pi/agent/pi-wechat-manager/daemon.pid ~/.pi/agent/pi-wechat-manager/daemon.sock
echo "   ✅ 守护进程已停止"

echo ""
echo "====================================="
echo "测试完成"
echo "====================================="
