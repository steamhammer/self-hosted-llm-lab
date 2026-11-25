#!/usr/bin/env bash
# Creates a RunPod pod from the lab image; the pod runs one job and deletes itself.
#
#   infra/runpod/up.sh --gpu "NVIDIA GeForce RTX 3090" --price 0.22 [options]
#
#   --gpu ID         GPU type id as `runpodctl` lists it (https://docs.runpod.io/references/gpu-types)
#   --price USD      hourly price shown in the console; recorded in env.json and session.json
#   --job NAME       rehearsal (default) | gpu-session
#   --configs LIST   for gpu-session: comma-separated serving/configs names
#   --label TAG      default <gpu>_<job>
#   --cloud TYPE     COMMUNITY (default, cheaper) | SECURE
#   --disk GB        container disk, holds the model weights (default 40)
#   --max-min N      hard runtime cap in minutes (default 60)
#   --keep-alive     keep the pod after the job (still capped by --max-min)
#   --dry-run        print the command with secrets redacted, create nothing
#
# Reads .env (R2_*, HF_TOKEN, LAB_IMAGE). Needs runpodctl configured with RUNPOD_API_KEY:
# https://docs.runpod.io/runpodctl/overview
set -euo pipefail
cd "$(dirname "$0")/../.."
. infra/lib.sh
load_env_file .env

GPU="" PRICE="" CLOUD=COMMUNITY DISK=40 DRY=0
JOB=rehearsal LABEL="" MAX_RUNTIME_MIN="${MAX_RUNTIME_MIN:-60}" KEEP_ALIVE=0
while (($#)); do
  case "$1" in
    --gpu) GPU="$2"; shift 2 ;;
    --price) PRICE="$2"; shift 2 ;;
    --job) JOB="$2"; shift 2 ;;
    --configs) CONFIGS="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --cloud) CLOUD="$2"; shift 2 ;;
    --disk) DISK="$2"; shift 2 ;;
    --max-min) MAX_RUNTIME_MIN="$2"; shift 2 ;;
    --keep-alive) KEEP_ALIVE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h | --help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
[[ -n "$GPU" && -n "$PRICE" ]] || die "--gpu and --price are required (see --help)"

TAG="$(printf '%s' "$GPU" | tr '[:upper:]-' '[:lower:] ' | sed -E 's/nvidia|geforce//g; s/[^a-z0-9]+//g')"
LABEL="${LABEL:-${TAG}_${JOB}}"
PROVIDER=runpod GPU_PRICE_PER_HOUR_USD="$PRICE"
export JOB LABEL MAX_RUNTIME_MIN KEEP_ALIVE PROVIDER GPU_PRICE_PER_HOUR_USD CONFIGS="${CONFIGS:-}"
launch_checks

CMD=(runpodctl pod create
  --name "lab-$LABEL"
  --image "$LAB_IMAGE"
  --gpu-id "$GPU" --gpu-count 1
  --cloud-type "$CLOUD"
  --container-disk-in-gb "$DISK" --volume-in-gb 0
  --min-cuda-version 12.9
  --ports "8000/http,8080/http"
  --env "$(pod_env_json)")

log "pod lab-$LABEL: $GPU ($CLOUD) at \$$PRICE/h, job $JOB, cap ${MAX_RUNTIME_MIN}m → max ≈ \$$(python3 -c "print(round($PRICE*$MAX_RUNTIME_MIN/60, 2))")"
if ((DRY)); then
  print_cmd "${CMD[@]}"
  exit 0
fi
"${CMD[@]}"
cat <<EOF

Watch:   runpodctl pod list      (logs: RunPod console → pod → Logs)
Results: infra/fetch.sh          (session folder appears in R2 within a minute)
Abort:   runpodctl pod delete <pod-id>
EOF
