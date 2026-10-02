#!/usr/bin/env bash
# 一条本地命令启动：重置数据 -> 播种停电案例 -> 启动看板服务。
set -euo pipefail
cd "$(dirname "$0")"

export CS_HOST="${CS_HOST:-127.0.0.1}"
export CS_PORT="${CS_PORT:-8000}"
export CS_DATA_DIR="${CS_DATA_DIR:-$(pwd)/data}"

PYTHON="${PYTHON:-python3}"

echo "==> [1/2] 重置数据库并播种「设备停电」案例"
"$PYTHON" -m app.seed

echo "==> [2/2] 启动闭店调度看板 http://${CS_HOST}:${CS_PORT}"
echo "    （Ctrl+C 停止）"
exec "$PYTHON" -m app.web.server
