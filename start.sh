#!/usr/bin/env bash
# CloudOps Console 一键启动
set -e
cd "$(dirname "$0")/backend"
PY="C:/Users/yyb/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
[ -x "$PY" ] || PY="python"
echo "启动 CloudOps Console → http://127.0.0.1:8848"
exec "$PY" run_server.py
