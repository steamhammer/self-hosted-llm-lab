#!/usr/bin/env bash
# Creates a RunPod pod from the lab image; the pod runs one job and deletes itself.
#
#   infra/runpod/up.sh --gpu "NVIDIA GeForce RTX 4090,NVIDIA RTX A5000" [options]
#
#   --gpu LIST       GPU type ids, comma-separated, tried in order until one is free
#                    (ids: https://docs.runpod.io/references/gpu-types, "GPU ID" column)
#   --max-price USD  delete the pod at once if RunPod bills more per hour (default 1.00)
#   --price USD      only if you want to record a price by hand; normally the price RunPod
#                    reports on creation is recorded and infra/fetch.sh writes it into the results
#   --job NAME       rehearsal (default) | gpu-session
#   --configs LIST   for gpu-session: comma-separated serving/configs names
#   --plan FILE      for gpu-session: plan to run (default bench/plans/gpu.yaml)
#   --scenarios LIST override the plan's scenarios, e.g. chat,rag
#   --no-gateway     gpu-session: skip the pass through the gateway (saves ~30 min)
#   --label TAG      default <gpu>_<job> or <gpu>_<config>
#   --cloud TYPE     SECURE (default: datacenter hosts, reliable image pulls) | COMMUNITY
#   --disk GB        container disk for model weights and caches (default 40, gpu-session 80)
#   --max-min N      hard runtime cap in minutes (default: the plan's worst-case estimate + 10% + 15)
#   --keep-alive     keep the pod after the job (still capped by --max-min)
#   --dry-run        print the estimate and the command with secrets redacted, create nothing
#
# Reads .env (R2_*, HF_TOKEN, LAB_IMAGE). Uses runpodctl when installed and configured
# (https://docs.runpod.io/runpodctl/overview); otherwise infra/runpod_api.py with RUNPOD_API_KEY.
set -euo pipefail
cd "$(dirname "$0")/../.."
. infra/lib.sh
load_env_file .env

GPUS="" PRICE="" MAX_PRICE=1.00 CLOUD=SECURE DISK="" DRY=0 MAX_MIN="" USER_LABEL=""
JOB=rehearsal KEEP_ALIVE=0
while (($#)); do
  case "$1" in
    --gpu) GPUS="$2"; shift 2 ;;
    --price) PRICE="$2"; shift 2 ;;
    --max-price) MAX_PRICE="$2"; shift 2 ;;
    --job) JOB="$2"; shift 2 ;;
    --configs) CONFIGS="$2"; shift 2 ;;
    --plan) PLAN="$2"; shift 2 ;;
    --scenarios) SCENARIOS="$2"; shift 2 ;;
    --no-gateway) GATEWAY_PASS=0; shift ;;
    --label) USER_LABEL="$2"; shift 2 ;;
    --cloud) CLOUD="$2"; shift 2 ;;
    --disk) DISK="$2"; shift 2 ;;
    --max-min) MAX_MIN="$2"; shift 2 ;;
    --keep-alive) KEEP_ALIVE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
[[ -n "$GPUS" ]] || die "--gpu is required (see --help)"
[[ "$JOB" != gpu-session || -n "${CONFIGS:-}" ]] || die "--job gpu-session needs --configs"
# Every config's weights stay on the container disk for the whole session, so the default
# disk grows with the configs: 30 GB for the image and caches plus a rough size per model.
weights_gb() {
  local total=0 c
  for c in ${1//,/ }; do
    case "$c" in
      *27b.bf16*) total=$((total + 60)) ;;
      *27b*) total=$((total + 35)) ;;
      *9b*) total=$((total + 20)) ;;
      *) total=$((total + 10)) ;;
    esac
  done
  echo "$total"
}
[[ -n "$DISK" ]] || if [[ "$JOB" == gpu-session ]]; then DISK=$((30 + $(weights_gb "$CONFIGS"))); else DISK=40; fi

# The cap comes from the plan unless given: a cap below the plan's length would cut the run.
EST="$(GATEWAY_PASS="${GATEWAY_PASS:-1}" plan_estimate "$JOB" "${PLAN:-}" "${CONFIGS:-}" "${SCENARIOS:-}")"
if [[ -n "$MAX_MIN" ]]; then
  MAX_RUNTIME_MIN="$MAX_MIN"
  ((MAX_MIN >= EST)) || log "WARNING: --max-min $MAX_MIN is below the worst-case estimate of ${EST}m"
else
  MAX_RUNTIME_MIN=$((EST * 11 / 10 + 15)) # the estimate is already a worst case
fi

PROVIDER=runpod
unset GPU_PRICE_PER_HOUR_USD
[[ -z "$PRICE" ]] || GPU_PRICE_PER_HOUR_USD="$PRICE"
export JOB MAX_RUNTIME_MIN KEEP_ALIVE PROVIDER CONFIGS="${CONFIGS:-}" PLAN="${PLAN:-}" SCENARIOS="${SCENARIOS:-}" GATEWAY_PASS="${GATEWAY_PASS:-}"
[[ -z "${GPU_PRICE_PER_HOUR_USD:-}" ]] || export GPU_PRICE_PER_HOUR_USD

log "job $JOB, worst case ≈ ${EST}m of work, cap ${MAX_RUNTIME_MIN}m (+ image pull, billed too)," \
  "max ≈ \$$(python3 -c "print(round($MAX_PRICE * ($MAX_RUNTIME_MIN + 15) / 60, 2))") at \$$MAX_PRICE/h"

IFS=',' read -r -a GPU_LIST <<<"$GPUS"
errors=()
for raw in "${GPU_LIST[@]}"; do
  GPU="$(printf '%s' "$raw" | sed -E 's/^ +| +$//g')"
  [[ -n "$GPU" ]] || continue
  TAG="$(printf '%s' "$GPU" | tr '[:upper:]-' '[:lower:] ' | sed -E 's/nvidia|geforce|generation//g; s/[^a-z0-9]+//g')"
  if [[ -n "$USER_LABEL" ]]; then
    LABEL="$USER_LABEL"
  elif [[ "$JOB" == gpu-session && "${CONFIGS:-}" != *,* ]]; then
    LABEL="${TAG}_${CONFIGS}"
  else
    LABEL="${TAG}_${JOB}"
  fi
  export LABEL
  launch_checks

  if command -v runpodctl >/dev/null; then
    CMD=(runpodctl pod create
    --name "lab-$LABEL"
    --image "$LAB_IMAGE"
    --gpu-id "$GPU" --gpu-count 1
    --cloud-type "$CLOUD"
    --container-disk-in-gb "$DISK" --volume-in-gb 0
    --min-cuda-version 12.9
    --ports "8000/http,8080/http"
    --env "$(pod_env_json)")
    DELETE=(runpodctl pod delete)
  else
    # No runpodctl: the REST API client reads the same settings as JSON on stdin.
    SPEC="$(POD_ENV="$(pod_env_json)" python3 -c 'import json, os, sys
a = sys.argv[1:]
print(json.dumps({"name": a[0], "image": a[1], "gpu": a[2], "cloud": a[3], "disk": int(a[4]),
                  "minCudaVersion": "12.9", "ports": ["8000/http", "8080/http"],
                  "env": json.loads(os.environ["POD_ENV"])}))' "lab-$LABEL" "$LAB_IMAGE" "$GPU" "$CLOUD" "$DISK")"
    # shellcheck disable=SC2016 # $1 is expanded by the inner bash
    CMD=(bash -c 'python3 infra/runpod_api.py create <<<"$1"' _ "$SPEC")
    DELETE=(python3 infra/runpod_api.py delete)
  fi

  if ((DRY)); then
    log "would try: $GPU ($CLOUD) as lab-$LABEL"
    print_cmd "${CMD[@]}"
    continue
  fi

  log "trying $GPU ($CLOUD)"
  # runpodctl echoes the whole pod spec, environment included: never print it as is.
  if ! OUT="$("${CMD[@]}" 2>&1)"; then
    msg="$(printf '%s' "$OUT" | redact | tr '\n' ' ' | head -c 300)"
    log "  not created: $msg"
    errors+=("$GPU: $msg")
    continue
  fi
  read -r ID COST < <(printf '%s' "$OUT" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except ValueError:
    d = {}
print(d.get("id") or "-", d.get("costPerHr") or "-")') || true
  [[ "${ID:-}" != "-" && -n "${ID:-}" ]] || die "unexpected runpodctl answer: $(printf '%s' "$OUT" | redact | head -c 400)"

  if [[ "$COST" != "-" ]] && python3 -c "import sys; sys.exit(0 if $COST > $MAX_PRICE else 1)"; then
    log "  pod $ID bills \$$COST/h, above --max-price \$$MAX_PRICE: deleting it"
    "${DELETE[@]}" "$ID" >/dev/null 2>&1 || log "  ERROR: delete $ID by hand: runpodctl pod delete $ID"
    errors+=("$GPU: \$$COST/h above the limit")
    continue
  fi

  # The pod's id is its session's machineId: fetch.sh takes the real price from this record.
  mkdir -p results
  python3 - "$ID" "$GPU" "$CLOUD" "$COST" "$LABEL" "$JOB" "${CONFIGS:-}" "$MAX_RUNTIME_MIN" >>results/launches.jsonl <<'PY'
import json, sys, datetime
pod, gpu, cloud, cost, label, job, configs, cap = sys.argv[1:9]
print(json.dumps({"provider": "runpod", "machineId": pod, "gpu": gpu, "cloud": cloud,
                  "pricePerHourUsd": None if cost == "-" else float(cost), "label": label, "job": job,
                  "configs": configs or None, "maxRuntimeMin": int(cap),
                  "createdAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}))
PY
  log "pod $ID created: $GPU at \$$COST/h; it deletes itself when the job ends or after ${MAX_RUNTIME_MIN}m"
  cat <<EOF

Watch:   runpodctl pod list      (logs: https://www.runpod.io/console/pods → $ID → Logs)
Results: infra/fetch.sh          (session folder appears in R2 once the image is pulled)
Abort:   runpodctl pod delete $ID
EOF
  exit 0
done

((DRY)) && exit 0
log "no pod created:"
for e in "${errors[@]}"; do log "  $e"; done
exit 1
