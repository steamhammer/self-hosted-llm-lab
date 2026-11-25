#!/usr/bin/env bash
# Rents the cheapest matching Vast.ai offer with the lab image; the instance runs one job and
# destroys itself.
#
#   infra/vast/up.sh --gpu RTX_3090 [options]
#
#   --gpu NAME       Vast gpu_name, spaces as underscores: RTX_3090, RTX_4090, L40S, A100_SXM4, H100_SXM
#   --max-price USD  skip offers above this $/h (default 1.00)
#   --min-down MBIT  host download speed as Vast measured it (default 1000): the image is ~11 GB
#   --job NAME       rehearsal (default) | gpu-session
#   --configs LIST   for gpu-session: comma-separated serving/configs names
#   --label TAG      default <gpu>_<job>
#   --disk GB        disk for the image and model weights (default 60)
#   --max-min N      hard runtime cap in minutes (default 60)
#   --keep-alive     keep the instance after the job (still capped by --max-min)
#   --dry-run        show the chosen offer and the command with secrets redacted, rent nothing
#
# Reads .env (R2_*, HF_TOKEN, LAB_IMAGE). Needs the vastai CLI with an API key set:
# https://docs.vast.ai/cli/get-started
set -euo pipefail
cd "$(dirname "$0")/../.."
. infra/lib.sh
load_env_file .env

GPU="" MAX_PRICE=1.00 MIN_DOWN=1000 DISK=60 DRY=0
JOB=rehearsal LABEL="" MAX_RUNTIME_MIN="${MAX_RUNTIME_MIN:-60}" KEEP_ALIVE=0
while (($#)); do
  case "$1" in
    --gpu) GPU="$2"; shift 2 ;;
    --max-price) MAX_PRICE="$2"; shift 2 ;;
    --min-down) MIN_DOWN="$2"; shift 2 ;;
    --job) JOB="$2"; shift 2 ;;
    --configs) CONFIGS="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --disk) DISK="$2"; shift 2 ;;
    --max-min) MAX_RUNTIME_MIN="$2"; shift 2 ;;
    --keep-alive) KEEP_ALIVE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
[[ -n "$GPU" ]] || die "--gpu is required (see --help)"
command -v vastai >/dev/null || die "vastai CLI not found: uv tool install vastai"
# Offer search works without a key, renting does not: check the login before anything else.
vastai show user --raw 2>/dev/null | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("id") else 1)' 2>/dev/null ||
  die "vastai is not logged in: read -rs K && vastai set api-key \"\$K\"; unset K  (key: https://cloud.vast.ai/manage-keys/)"

# Search syntax: https://docs.vast.ai/cli/commands (search offers). Verified hosts, one GPU,
# a driver for CUDA 12.9+, enough disk and bandwidth to pull the ~11 GB image and weights, and
# no more than half a cent per GB downloaded (some hosts bill traffic on top of the hourly rate).
QUERY="gpu_name=$GPU num_gpus=1 verified=true rentable=true reliability>0.98 cuda_vers>=12.9 disk_space>=$DISK inet_down>=$MIN_DOWN inet_down_cost<=0.005 dph<=$MAX_PRICE"
log "searching: $QUERY"
read -r OFFER PRICE WHERE DOWN < <(vastai search offers "$QUERY" -o dph --raw | python3 -c '
import json, sys
offers = json.load(sys.stdin)
if not offers:
    sys.exit("no offers match")
o = offers[0]
price = o.get("dph_total") or o["dph"]
print(o["id"], round(price, 4), (o.get("geolocation") or "?").replace(" ", "_"), int(o.get("inet_down") or 0))') ||
  die "no offer matches; raise --max-price or try another --gpu"

TAG="$(printf '%s' "$GPU" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+//g')"
LABEL="${LABEL:-${TAG}_${JOB}}"
PROVIDER=vast GPU_PRICE_PER_HOUR_USD="$PRICE"
export JOB LABEL MAX_RUNTIME_MIN KEEP_ALIVE PROVIDER GPU_PRICE_PER_HOUR_USD CONFIGS="${CONFIGS:-}"
launch_checks

# Args launch mode keeps the image ENTRYPOINT (bootstrap.sh) and injects no SSH or Jupyter;
# bootstrap ignores the "run" argument, which only satisfies the CLI.
CMD=(vastai create instance "$OFFER"
  --image "$LAB_IMAGE"
  --disk "$DISK"
  --label "lab-$LABEL"
  --env "$(pod_env_docker) -p 8000:8000 -p 8080:8080"
  --cancel-unavail
  --raw
  --args run)

log "offer $OFFER: $GPU in $WHERE (${DOWN} Mbit/s down) at \$$PRICE/h, job $JOB, cap ${MAX_RUNTIME_MIN}m → max ≈ \$$(python3 -c "print(round($PRICE*$MAX_RUNTIME_MIN/60, 2))")"
if ((DRY)); then
  print_cmd "${CMD[@]}"
  exit 0
fi
# vastai exits 0 even when the API refuses, so judge by the response body.
OUT="$("${CMD[@]}" 2>&1)" || true
ID="$(printf '%s' "$OUT" | python3 -c 'import json,sys
try:
    r = json.load(sys.stdin)
except ValueError:
    sys.exit(1)
if not r.get("success") or not r.get("new_contract"):
    sys.exit(1)
print(r["new_contract"])' 2>/dev/null)" || die "instance not created: $OUT"
log "instance $ID created; it deletes itself when the job ends or after ${MAX_RUNTIME_MIN}m"
cat <<EOF

Watch:   infra/vast/status.sh $ID   (image pull progress; then: vastai logs $ID --tail 30)
Results: infra/fetch.sh          (session folder appears in R2 within a few minutes)
Abort:   vastai destroy instance $ID
EOF
