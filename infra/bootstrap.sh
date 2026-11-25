#!/usr/bin/env bash
# Entry point of the lab image (infra/image/Dockerfile). One container start = one session:
#
#   preflight → watchdog → job (infra/jobs/$JOB.sh) → upload results → delete the machine
#
# The machine deletes itself whatever happens: job success, job failure, a bad config, or the
# MAX_RUNTIME_MIN watchdog. Results go to R2 every SYNC_INTERVAL_S and once more at the end,
# so a crash loses at most a few minutes of data. See docs/adr/0006-pod-automation.md.
#
# Env (set by infra/runpod/up.sh or infra/vast/up.sh):
#   JOB              rehearsal | gpu-session | path to a script        (default rehearsal)
#   LABEL            session tag, e.g. 3090_rehearsal                  (default $JOB)
#   MAX_RUNTIME_MIN  hard cap for the whole session                    (default 60)
#   KEEP_ALIVE=1     keep the machine after the job (for SSH), still capped by MAX_RUNTIME_MIN
#   R2_*             bucket and scoped token (see .env.example); RESULTS_PREFIX (default runs)
#   HF_TOKEN         optional, for gated models and higher Hugging Face rate limits
#   PROVIDER, GPU_PRICE_PER_HOUR_USD   recorded in env.json and session.json
# Test-only: RESULTS_REMOTE (local dir instead of R2), TERMINATE_CMD (instead of the provider
#   API), LAB_FAKE_VLLM=1 (mock upstream instead of vLLM), LAB_NO_SLEEP=1 (exit at the end).
set -uo pipefail
LAB="$(cd "$(dirname "$0")/.." && pwd)"
cd "$LAB" || exit 1
. infra/lib.sh

JOB="${JOB:-rehearsal}"
JOB_NAME="$(basename "$JOB" .sh)"
LABEL="${LABEL:-$JOB_NAME}"
[[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "LABEL may contain only letters, digits, '.', '_' and '-': $LABEL" >&2
  LABEL=invalid-label
}
MAX_RUNTIME_MIN="${MAX_RUNTIME_MIN:-60}"
MAX_RUNTIME_S="${MAX_RUNTIME_S:-$((MAX_RUNTIME_MIN * 60))}" # seconds override: tests only
SYNC_INTERVAL_S="${SYNC_INTERVAL_S:-300}"
CLEANUP_GRACE_S="${CLEANUP_GRACE_S:-600}"
WORK_ROOT="${LAB_WORK_ROOT:-/var/lab}"
DONE_MARKER="$WORK_ROOT/.session-finished"
mkdir -p "$WORK_ROOT"

terminate_machine() {
  if [[ -n "${TERMINATE_CMD:-}" ]]; then
    bash -c "$TERMINATE_CMD"
  else
    python3 infra/terminate.py
  fi
}

park() {
  # RunPod restarts a container whose main process exits, which would rerun the job. Wait here
  # until the deletion takes effect instead.
  [[ "${LAB_NO_SLEEP:-0}" == 1 ]] && exit "${1:-0}"
  trap - TERM INT # an ignored signal would stay ignored in the exec'd sleep
  exec sleep infinity
}

# A restarted container (provider restart, crash after cleanup) must not run the job again,
# and its watchdog is gone with the old process, so delete the machine even with KEEP_ALIVE.
if [[ -f "$DONE_MARKER" ]]; then
  log "session already finished ($(cat "$DONE_MARKER")); deleting the machine instead of rerunning"
  terminate_machine || log "self-termination failed"
  park 0
fi

export LAB_SESSION="${LAB_SESSION:-$(date -u +%Y%m%dT%H%MZ)_${LABEL}}"
export LAB_WORK="$WORK_ROOT/$LAB_SESSION"
export LAB_LOGS="$LAB_WORK/logs" LAB_RESULTS="$LAB_WORK/results"
export HF_HOME="${HF_HOME:-$WORK_ROOT/hf}"
mkdir -p "$LAB_LOGS" "$LAB_RESULTS"
exec > >(tee -a "$LAB_LOGS/bootstrap.log") 2>&1

STARTED_AT="$(date -u +%FT%TZ)"
START_S=$(date +%s)
STATUS=running JOB_PID="" SYNC_PID="" WATCHDOG_PID=""

log "session $LAB_SESSION: job=$JOB max_runtime=${MAX_RUNTIME_S}s keep_alive=${KEEP_ALIVE:-0}"
log "image ${LAB_IMAGE:-local} commit ${LAB_GIT_SHA:-none} provider ${PROVIDER:-unknown}" \
  "machine ${RUNPOD_POD_ID:-${CONTAINER_ID:-local}}"

rclone_env
# Destination, or empty when the R2 settings are incomplete (preflight then fails the session).
DEST=""
if [[ -n "${RESULTS_REMOTE:-}" || (-n "${R2_BUCKET:-}" && -n "${R2_ACCESS_KEY_ID:-}" && -n "${R2_SECRET_ACCESS_KEY:-}") ]]; then
  DEST="$(remote_base)/$LAB_SESSION"
fi
export DEST

# upload [live] → copies the session folder to $DEST.
# "live" is the periodic upload while vLLM, the GPU sampler and this script still append to their
# logs: rclone would reject those files ("source file is being updated", md5 mismatch), so a live
# upload takes them as they are at that moment and skips the checksum. The final upload runs
# after every writer has stopped and keeps full verification.
upload() {
  [[ -n "$DEST" ]] || return 1
  local live=()
  [[ "${1:-}" == live ]] && live=(--local-no-check-updated --ignore-checksum)
  rclone copy "$LAB_WORK" "$DEST" --exclude '*.pid' --transfers 8 --retries 3 \
    --low-level-retries 10 --stats 0 --log-level ERROR ${live[@]+"${live[@]}"}
}

write_session() {
  STATUS="$1" EXIT_CODE="$2" FINISHED_AT="$(date -u +%FT%TZ)" DURATION_S=$(($(date +%s) - START_S)) \
    STARTED_AT="$STARTED_AT" JOB="$JOB" LABEL="$LABEL" python3 - "$LAB_WORK/session.json" <<'PY'
import json, os, shutil, subprocess, sys

def gpus():
    if not shutil.which("nvidia-smi"):
        return []
    out = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                         capture_output=True, text=True, check=False).stdout
    return [line.strip() for line in out.splitlines() if line.strip()]

env = os.environ.get
price = float(env("GPU_PRICE_PER_HOUR_USD") or 0) or None
duration = int(env("DURATION_S"))
code = env("EXIT_CODE")
doc = {
    "session": env("LAB_SESSION"), "label": env("LABEL"), "job": env("JOB"),
    "status": env("STATUS"), "exitCode": int(code) if code else None,
    "startedAt": env("STARTED_AT"), "finishedAt": env("FINISHED_AT") if code else None,
    "durationS": duration,
    "provider": env("PROVIDER"), "machineId": env("RUNPOD_POD_ID") or env("CONTAINER_ID"),
    "gpus": gpus(), "image": env("LAB_IMAGE"), "commit": env("LAB_GIT_SHA"),
    "pricePerHourUsd": price,
    # Container time only: billing also covers image pull and model download before this.
    "estimatedCostUsd": round(price * duration / 3600, 4) if price else None,
}
with open(sys.argv[1], "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
PY
}

CLEANING=0
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  local rc=$?
  ((CLEANING)) && return
  CLEANING=1
  trap '' TERM INT
  [[ -n "$SYNC_PID" ]] && kill -- "-$SYNC_PID" 2>/dev/null
  if [[ -n "$JOB_PID" ]] && kill -0 "$JOB_PID" 2>/dev/null; then
    log "stopping job (pid $JOB_PID)"
    kill -TERM -- "-$JOB_PID" 2>/dev/null || true
    sleep 5
    kill -KILL -- "-$JOB_PID" 2>/dev/null || true
  fi
  infra/gateway.sh stop >/dev/null 2>&1 || true
  infra/serve.sh stop >/dev/null 2>&1 || true

  local status=succeeded
  if [[ "$STATUS" == timeout ]]; then status=timeout; elif ((rc != 0)); then status=failed; fi
  write_session "$status" "$rc"
  echo "$LAB_SESSION $status" >"$DONE_MARKER"
  log "session $status (exit $rc) after $(($(date +%s) - START_S))s; uploading to $DEST"
  sleep 1 # let tee flush the log
  local ok=0
  [[ -n "$DEST" ]] || log "no results destination configured"
  for attempt in 1 2 3; do
    [[ -n "$DEST" ]] || break
    # The last attempt tolerates files that still change (rclone's own errors land in bootstrap.log).
    if upload "$([[ $attempt == 3 ]] && echo live)"; then
      ok=1
      break
    fi
    log "upload attempt $attempt failed"
    sleep $((attempt * 10))
  done
  if ((ok)); then
    log "results uploaded: $DEST"
  else
    log "ERROR: results NOT uploaded; logs only on this machine"
  fi

  if [[ "${KEEP_ALIVE:-0}" == 1 && "$status" != timeout ]]; then
    log "KEEP_ALIVE=1: machine stays up until the watchdog (${MAX_RUNTIME_S}s) or a manual delete"
    # Sleep out the rest of the cap here (the watchdog's TERM may already have been swallowed
    # while cleanup was uploading); a TERM still ends the wait early.
    local left=$((MAX_RUNTIME_S - ($(date +%s) - START_S)))
    if ((left > 0)); then
      trap 'log "KEEP_ALIVE ended by TERM"' TERM
      sleep "$left" &
      wait $!
      kill $! 2>/dev/null
      trap '' TERM
    fi
    log "KEEP_ALIVE time is over"
  fi
  log "deleting this machine"
  upload live || true # bootstrap.log is still open for writing here
  terminate_machine || log "ERROR: self-termination failed: delete the machine by hand"
  [[ -n "$WATCHDOG_PID" ]] && kill -- "-$WATCHDOG_PID" 2>/dev/null
  park "$rc"
}
trap cleanup EXIT
trap 'STATUS=timeout; log "watchdog: limit of ${MAX_RUNTIME_S}s reached"; exit 124' TERM
trap 'log "interrupted"; exit 130' INT

# Watchdog: TERM to this script at the limit; if cleanup hangs, delete the machine anyway.
# Background loops run in their own process groups (setsid), so cleanup can stop them together
# with their `sleep` children.
export -f log terminate_machine upload
export MAIN_PID=$$ MAX_RUNTIME_S CLEANUP_GRACE_S SYNC_INTERVAL_S
# shellcheck disable=SC2016 # expanded by the child shell
setsid bash -c '
  sleep "$MAX_RUNTIME_S"
  kill -TERM "$MAIN_PID" 2>/dev/null
  sleep "$CLEANUP_GRACE_S"
  log "watchdog: cleanup did not finish in ${CLEANUP_GRACE_S}s; forcing deletion"
  terminate_machine' &
WATCHDOG_PID=$!

# Preflight: fail in seconds, not after a 20-minute model download.
case "$JOB" in
  */*) JOB_SCRIPT="$JOB" ;;
  *) JOB_SCRIPT="infra/jobs/$JOB.sh" ;;
esac
[[ -f "$JOB_SCRIPT" ]] || die "no such job: $JOB_SCRIPT"
[[ "$LABEL" != invalid-label ]] || die "invalid LABEL"
if [[ -z "$DEST" ]]; then
  die "R2 is not configured: set R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID"
fi
write_session running ""
upload || die "cannot write to $DEST: check the R2 token and bucket"
log "preflight ok: results go to $DEST"

# Periodic upload, so a crash or a hung cleanup loses at most one interval.
# shellcheck disable=SC2016
setsid bash -c 'while sleep "$SYNC_INTERVAL_S"; do upload live || log "periodic upload failed"; done' &
SYNC_PID=$!

setsid bash "$JOB_SCRIPT" &
JOB_PID=$!
wait "$JOB_PID"
exit $?
