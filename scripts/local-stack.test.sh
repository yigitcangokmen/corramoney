#!/usr/bin/env bash
# Regression test for scripts/local-stack.sh pid handling: a pid file left behind by a reboot or crash
# must never make local:up or local:down signal a process the script did not start.
#   bash scripts/local-stack.test.sh
set -euo pipefail
LOCAL_STACK_LIB=1
# shellcheck source=local-stack.sh
. "$(dirname "${BASH_SOURCE[0]}")/local-stack.sh"
STATE=$(mktemp -d)
trap 'rm -rf "$STATE"' EXIT

ok() { printf 'ok   %s\n' "$*"; }
no() { printf 'FAIL %s\n' "$*"; exit 1; }

# 1. A stale pid file names an unrelated process (its own process group, as a reused pid could be).
set -m; sleep 300 & other=$!; set +m
echo "$other" > "$STATE/orchestrator.pid"
if alive orchestrator; then no "alive trusted a pid file naming an unrelated process"; fi
[ -f "$STATE/orchestrator.pid" ] && no "alive kept the stale pid file"
ok "alive rejects a reused pid and removes the stale pid file"
echo "$other" > "$STATE/web.pid"
stop_bg web
kill -0 "$other" 2>/dev/null || no "stop_bg killed an unrelated process"
[ -f "$STATE/web.pid" ] && no "stop_bg kept the stale pid file"
ok "stop_bg leaves an unrelated process alone"
kill "$other" 2>/dev/null || true

# 2. A process the script started is still seen and stopped.
start_bg orchestrator bash -c 'sleep 300; : @corra/orchestrator'
started=$(cat "$STATE/orchestrator.pid")
alive orchestrator || no "alive missed the process start_bg started"
ok "alive sees the process it started"
stop_bg orchestrator
sleep 1
kill -0 "$started" 2>/dev/null && no "stop_bg did not stop the process it started"
ok "stop_bg stops the process it started"
echo "local-stack.test OK"
