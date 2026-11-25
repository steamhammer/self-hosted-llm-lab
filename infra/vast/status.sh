#!/usr/bin/env bash
# Shows where a Vast.ai instance is: image pull, container start, or the job itself.
#
#   infra/vast/status.sh <instance-id> [--watch]
#
# While the status is "loading", status_msg carries the host's docker pull progress or an error.
# With --watch, repeats every 30 s until the instance is running or gone.
set -euo pipefail
cd "$(dirname "$0")/../.."
. infra/lib.sh
load_env_file .env
ID="${1:?usage: $0 <instance-id> [--watch]}"
WATCH="${2:-}"

# Reads `vastai show instance --raw` on stdin; exit 0 = running, 1 = not yet, 3 = gone.
read -r -d '' SUMMARY <<'PY' || true
import json, sys, time
try:
    i = json.load(sys.stdin)
except ValueError:
    i = {}
if isinstance(i, dict) and "instances" in i:  # some CLI versions wrap the instance
    i = i["instances"] or {}
if isinstance(i, list):
    i = i[0] if i else {}
if not isinstance(i, dict) or not i.get("id") or i.get("error"):
    print("gone (no such instance)")
    sys.exit(3)
age = (time.time() - (i.get("start_date") or time.time())) / 60
msg = " ".join((i.get("status_msg") or "").split())[:160]
state, wants = i.get("actual_status") or "?", i.get("intended_status") or "?"
where = f"{i.get('gpu_name')} at {i.get('geolocation')}"
print(f"{state} (wants {wants}), {age:.0f} min since start, {where}: {msg}")
sys.exit(0 if state == "running" else 1)
PY

show() { vastai show instance "$ID" --raw 2>/dev/null | python3 -c "$SUMMARY"; }

if [[ "$WATCH" != --watch ]]; then
  show || true
  exit 0
fi
while true; do
  rc=0
  printf '[%s] ' "$(date +%H:%M:%S)"
  show || rc=$?
  ((rc == 1)) || break
  sleep 30
done
