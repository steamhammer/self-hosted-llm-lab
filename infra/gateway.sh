#!/usr/bin/env bash
# Starts or stops the API gateway next to vLLM on the pod, in benchmark mode.
#
#   infra/gateway.sh start|stop
#
# Benchmark mode: admission limits and the TTFT timeout are pushed out of the way, so a load test
# through the gateway measures the proxy's overhead, not its protective 429s and 504s
# (ADR-0004). Production defaults stay in gateway/src/config.ts.
set -euo pipefail
cd "$(dirname "$0")/.."
. infra/lib.sh

WORK="${LAB_WORK:-/tmp/lab-work}"
LOGS="${LAB_LOGS:-$WORK}"
PID_FILE="$WORK/gateway.pid"
PORT=8080
mkdir -p "$WORK" "$LOGS"

# The image ships the single-file bundle; a source checkout runs the TypeScript directly.
if [[ -f gateway/dist/gateway.mjs ]]; then ENTRY=gateway/dist/gateway.mjs; else ENTRY=gateway/src/main.ts; fi

case "${1:-}" in
  start)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then exit 0; fi
    PORT=$PORT UPSTREAM_URL=http://127.0.0.1:8000 \
      MAX_INFLIGHT=100000 MAX_UPSTREAM_WAITING=100000 TTFT_TIMEOUT_MS=600000 \
      LOG_LEVEL=warn setsid node "$ENTRY" >>"$LOGS/gateway.log" 2>&1 &
    echo $! >"$PID_FILE"
    wait_http "http://127.0.0.1:$PORT/health" 60 "$(cat "$PID_FILE")" || die "gateway did not start"
    log "gateway ready on :$PORT (pid $(cat "$PID_FILE"))"
    ;;
  stop) stop_pid_file "$PID_FILE" ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
