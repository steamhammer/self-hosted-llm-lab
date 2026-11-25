#!/usr/bin/env bash
# Failure-mode tests for infra/bootstrap.sh, without a GPU, R2 or a provider (~30 s):
# local folder instead of R2, a file write instead of the delete API call.
#
#   infra/tests/bootstrap.test.sh
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
# The pod runs Linux; bootstrap relies on setsid and GNU timeout, which macOS lacks.
if [[ "$(uname -s)" != Linux ]]; then
  echo "skip: bootstrap tests run on Linux only (CI runs them)"
  exit 0
fi
command -v rclone >/dev/null || {
  echo "rclone is required"
  exit 2
}

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/jobs"
printf 'echo ok\n' >"$T/jobs/ok.sh"
printf 'echo failing; exit 7\n' >"$T/jobs/fail.sh"
printf 'sleep 300\n' >"$T/jobs/sleep.sh"
FAILED=0

# run NAME [VAR=value...] → runs bootstrap in a fresh sandbox; sets RC, STATUS, DELETES.
run() {
  local name="$1"
  shift
  rm -rf "$T/work" "$T/remote" "$T/deleted"
  mkdir -p "$T/remote"
  env -u R2_BUCKET -u R2_ACCESS_KEY_ID -u R2_SECRET_ACCESS_KEY \
    LAB_WORK_ROOT="$T/work" LAB_NO_SLEEP=1 TERMINATE_CMD="echo deleted >>'$T/deleted'" \
    RESULTS_REMOTE="$T/remote" "$@" timeout 60 infra/bootstrap.sh >"$T/$name.log" 2>&1
  RC=$?
  STATUS="$(python3 -c 'import glob,json,sys; f=glob.glob(sys.argv[1]); print(json.load(open(f[0]))["status"] if f else "-")' "$T/remote/*/session.json")"
  DELETES="$(cat "$T/deleted" 2>/dev/null | wc -l | tr -d ' ')"
}

expect() {
  local name="$1" want_rc="$2" want_status="$3" want_deletes="$4"
  if [[ "$RC" == "$want_rc" && "$STATUS" == "$want_status" && "$DELETES" == "$want_deletes" ]]; then
    echo "ok   $name"
  else
    echo "FAIL $name: rc=$RC status=$STATUS deletes=$DELETES (want $want_rc/$want_status/$want_deletes)"
    sed 's/^/     | /' "$T/$name.log" | tail -n 15
    FAILED=1
  fi
}

run success JOB="$T/jobs/ok.sh"
expect success 0 succeeded 1

run job-fails JOB="$T/jobs/fail.sh"
expect job-fails 7 failed 1

run watchdog JOB="$T/jobs/sleep.sh" MAX_RUNTIME_S=3
expect watchdog 124 timeout 1

run unknown-job JOB=no-such-job
expect unknown-job 1 failed 1

run bad-label JOB="$T/jobs/ok.sh" LABEL="a/b"
expect bad-label 1 failed 1

run no-r2 JOB="$T/jobs/ok.sh" RESULTS_REMOTE=
expect no-r2 1 - 1

# A restarted container must delete the machine, not rerun the job.
run first JOB="$T/jobs/ok.sh"
env LAB_WORK_ROOT="$T/work" LAB_NO_SLEEP=1 TERMINATE_CMD="echo deleted >>'$T/deleted'" \
  JOB="$T/jobs/ok.sh" timeout 30 infra/bootstrap.sh >"$T/restart.log" 2>&1
RC=$?
DELETES="$(wc -l <"$T/deleted" | tr -d ' ')"
STATUS=succeeded
grep -q "not running\|instead of rerunning" "$T/restart.log" || RC=99
expect restart 0 succeeded 2

# KEEP_ALIVE holds the machine until the cap, then deletes it.
run keep-alive JOB="$T/jobs/ok.sh" KEEP_ALIVE=1 MAX_RUNTIME_S=4 CLEANUP_GRACE_S=30
expect keep-alive 0 succeeded 1

exit "$FAILED"
