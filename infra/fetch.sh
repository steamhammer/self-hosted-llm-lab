#!/usr/bin/env bash
# Downloads pod sessions from R2 and files their runs where the analysis expects them.
#
#   infra/fetch.sh                 list sessions in the bucket (newest last)
#   infra/fetch.sh <session>|latest   download one session and analyse its runs
#
# Layout after a fetch:
#   results/sessions/<session>/     session.json (tracked), logs/ and results/ (git-ignored)
#   results/raw/<run>/              runs of measurement jobs (tracked, methodology §10)
#   results/local/<run>/            runs of rehearsals (git-ignored)
# Reads R2_* from .env; RESULTS_REMOTE overrides the bucket with a local directory (tests).
set -euo pipefail
cd "$(dirname "$0")/.."
. infra/lib.sh
load_env_file .env
rclone_env
command -v rclone >/dev/null || die "rclone not found: brew install rclone (https://rclone.org/install/)"
BASE="$(remote_base)"

if (($# == 0)); then
  rclone lsf --dirs-only "$BASE" | sed 's:/$::' | sort
  exit 0
fi

SESSION="$1"
if [[ "$SESSION" == latest ]]; then
  SESSION="$(rclone lsf --dirs-only "$BASE" | sed 's:/$::' | sort | tail -n1)"
  [[ -n "$SESSION" ]] || die "no sessions in $BASE"
fi
DEST="results/sessions/$SESSION"
mkdir -p "$DEST"
log "downloading $BASE/$SESSION → $DEST"
rclone copy "$BASE/$SESSION" "$DEST" --transfers 8 --stats 0 --log-level ERROR

[[ -f "$DEST/session.json" ]] || die "no session.json in $DEST: not a lab session?"
read -r JOB STATUS < <(python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); print(s.get("job"), s.get("status"))' "$DEST/session.json")
log "session $SESSION: job $JOB, status $STATUS"
[[ "$STATUS" == succeeded ]] || log "WARNING: the session did not succeed; see $DEST/logs/bootstrap.log"

# Rehearsals check the pipeline; their numbers are not results.
if [[ "$JOB" == rehearsal ]]; then ROOT=results/local; else ROOT=results/raw; fi
mkdir -p "$ROOT"
for run in "$DEST"/results/*/; do
  [[ -f "$run/env.json" ]] || continue
  name="$(basename "$run")"
  if [[ -e "$ROOT/$name" ]]; then
    log "skip $ROOT/$name: already there"
    continue
  fi
  cp -R "$run" "$ROOT/$name"
  log "run → $ROOT/$name"
  if command -v uv >/dev/null; then
    uv run --package bench python bench/analyze/analyze.py report "$ROOT/$name" ||
      log "analysis of $name failed"
  fi
done
