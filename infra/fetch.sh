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
# rclone when installed (https://rclone.org/install/); otherwise the standard-library client
# infra/r2.py, which needs nothing installed (R2 only, not a RESULTS_REMOTE folder).
if command -v rclone >/dev/null; then
  remote_dirs() { rclone lsf --dirs-only "$BASE" | sed 's:/$::'; }
  remote_get() { rclone copy "$BASE/$1" "$2" --transfers 8 --stats 0 --log-level ERROR; }
else
  [[ -z "${RESULTS_REMOTE:-}" ]] || die "RESULTS_REMOTE needs rclone"
  log "rclone not found: using infra/r2.py"
  PREFIX="${RESULTS_PREFIX:-runs}"
  remote_dirs() { python3 infra/r2.py dirs "$PREFIX/"; }
  remote_get() { python3 infra/r2.py get "$PREFIX/$1/" "$2" >/dev/null; }
fi
BASE="$(remote_base)"

if (($# == 0)); then
  remote_dirs | sort
  exit 0
fi

SESSION="$1"
if [[ "$SESSION" == latest ]]; then
  SESSION="$(remote_dirs | sort | tail -n1)"
  [[ -n "$SESSION" ]] || die "no sessions in $BASE"
fi
DEST="results/sessions/$SESSION"
mkdir -p "$DEST"
log "downloading $BASE/$SESSION → $DEST"
remote_get "$SESSION" "$DEST"

[[ -f "$DEST/session.json" ]] || die "no session.json in $DEST: not a lab session?"
read -r JOB STATUS < <(python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); print(s.get("job"), s.get("status"))' "$DEST/session.json")
log "session $SESSION: job $JOB, status $STATUS"
[[ "$STATUS" == succeeded ]] || log "WARNING: the session did not succeed; see $DEST/logs/bootstrap.log"

# The launcher recorded what the provider actually bills (results/launches.jsonl); write that
# price into the session and its runs, so the analysis computes $/1M tokens from it.
if [[ -f results/launches.jsonl ]]; then
  python3 - "$DEST" results/launches.jsonl <<'PY'
import glob, json, os, sys
dest, launches = sys.argv[1], sys.argv[2]
session_path = os.path.join(dest, "session.json")
session = json.load(open(session_path))
price = None
for line in open(launches):
    rec = json.loads(line)
    if rec.get("machineId") == session.get("machineId") and rec.get("pricePerHourUsd"):
        price = rec["pricePerHourUsd"]
if price is None or session.get("pricePerHourUsd") == price:
    sys.exit(0)
session["pricePerHourUsd"] = price
session["estimatedCostUsd"] = round(price * (session.get("durationS") or 0) / 3600, 4)
session["priceSource"] = "provider, at pod creation"
json.dump(session, open(session_path, "w"), indent=2)
for env_path in glob.glob(os.path.join(dest, "results", "*", "env.json")):
    env = json.load(open(env_path))
    env["pricePerHourUsd"], env["priceSource"] = price, "provider, at pod creation"
    json.dump(env, open(env_path, "w"), indent=2)
print(f"[fetch] price set to ${price}/h from results/launches.jsonl")
PY
fi

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
