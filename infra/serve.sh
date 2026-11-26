#!/usr/bin/env bash
# Starts, stops or restarts vLLM in the background and waits until it is healthy.
#
#   infra/serve.sh start|stop|restart|status
#
# Env: VLLM_CONFIG     vLLM config file (serving/configs/*.yaml), required for start
#      LAB_WORK        directory for the pid file (default /tmp/lab-work)
#      LAB_LOGS        directory for vllm.log (default $LAB_WORK)
#      VLLM_START_TIMEOUT_S   default 1800 (first start downloads the model)
#      VLLM_EXTRA_ARGS extra flags after the config, e.g. "--max-model-len 16384" (eval runs)
#      LAB_FAKE_VLLM=1 start the mock upstream in simulation mode instead (tests without a GPU)
#
# Used by bootstrap.sh and as the plans' beforeScenario hook (fresh server per scenario).
set -euo pipefail
cd "$(dirname "$0")/.."
. infra/lib.sh

WORK="${LAB_WORK:-/tmp/lab-work}"
LOGS="${LAB_LOGS:-$WORK}"
PID_FILE="$WORK/vllm.pid"
PORT=8000
mkdir -p "$WORK" "$LOGS"

running() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

start() {
  if running; then
    log "vLLM already running (pid $(cat "$PID_FILE"))"
    return 0
  fi
  if [[ "${LAB_FAKE_VLLM:-0}" == 1 ]]; then
    MOCK_SIM=1 PORT=$PORT setsid node mock-upstream/src/main.ts >>"$LOGS/vllm.log" 2>&1 &
  else
    : "${VLLM_CONFIG:?VLLM_CONFIG is not set}"
    local extra=()
    read -r -a extra <<<"${VLLM_EXTRA_ARGS:-}"
    setsid vllm serve --config "$VLLM_CONFIG" --port "$PORT" ${extra[@]+"${extra[@]}"} \
      >>"$LOGS/vllm.log" 2>&1 &
  fi
  echo $! >"$PID_FILE"
  log "vLLM starting (pid $(cat "$PID_FILE"), config ${VLLM_CONFIG:-mock} ${VLLM_EXTRA_ARGS:-}); log: $LOGS/vllm.log"
  if ! wait_http "http://127.0.0.1:$PORT/health" "${VLLM_START_TIMEOUT_S:-1800}" "$(cat "$PID_FILE")"; then
    tail -n 60 "$LOGS/vllm.log" || true
    die "vLLM did not become healthy"
  fi
  log "vLLM ready"
}

stop() {
  running || {
    rm -f "$PID_FILE"
    return 0
  }
  log "stopping vLLM (pid $(cat "$PID_FILE"))"
  stop_pid_file "$PID_FILE"
  sleep 3 # let the driver release GPU memory
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart)
    stop
    start
    ;;
  status) if running; then echo running; else echo stopped; fi ;;
  *)
    echo "usage: $0 start|stop|restart|status" >&2
    exit 2
    ;;
esac
