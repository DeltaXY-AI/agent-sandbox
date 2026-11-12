#!/bin/sh
# Runs one fx turn. Starts the gateway relay first if it is not running
# (it does not survive a sandbox stop). All arguments go to `fx ask`.
set -eu

RELAY=/opt/agent-sandbox/gateway-relay.mjs
PORT="${RELAY_PORT:-8787}"

if ! curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
  NODE_USE_ENV_PROXY=1 RELAY_PORT="$PORT" setsid nohup node "$RELAY" >/tmp/gateway-relay.log 2>&1 </dev/null &
  i=0
  until curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 50 ]; then
      echo "gateway relay did not start" >&2
      exit 70
    fi
    sleep 0.1
  done
fi

export FX_GATEWAY_BASE_URL="http://127.0.0.1:$PORT"
export FX_GATEWAY_CHAT_URL="http://127.0.0.1:$PORT/v4/ai/language-model"
export FX_AUTO_UPGRADE=0
exec fx ask "$@"
