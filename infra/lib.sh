# Shared helpers for infra scripts. Sourced, not executed. Works on the pod (vLLM image, which
# has python3 but not necessarily curl) and on a laptop.
# shellcheck shell=bash

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() {
  log "ERROR: $*"
  exit 1
}

# Loads KEY=VALUE pairs from a dotenv file into the environment (laptop side: .env).
# An empty `KEY=` line is dropped rather than exported: vastai and runpodctl prefer
# VAST_API_KEY / RUNPOD_API_KEY from the environment, and an empty one would hide the key
# they keep in their own config.
load_env_file() {
  [[ -f "$1" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  . "$1"
  set +a
  local k
  while IFS='=' read -r k _; do
    [[ "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [[ -n "${!k:-}" ]] || unset "$k"
  done <"$1"
}

# Defines an rclone remote named "r2" from the R2_* variables, without any rclone config file.
rclone_env() {
  # Remote defined by env vars only; an empty config keeps rclone from looking for a file.
  export RCLONE_CONFIG="${RCLONE_CONFIG:-/dev/null}"
  export RCLONE_CONFIG_R2_TYPE=s3
  export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2_REGION=auto
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}"
  export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
  export RCLONE_CONFIG_R2_ENDPOINT="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID:-missing}.r2.cloudflarestorage.com}"
  # A token scoped to one bucket cannot create or list buckets.
  export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
}

# Where a session's files go. RESULTS_REMOTE overrides it (a local directory in tests).
remote_base() {
  if [[ -n "${RESULTS_REMOTE:-}" ]]; then
    printf '%s\n' "$RESULTS_REMOTE"
  else
    printf 'r2:%s/%s\n' "${R2_BUCKET:?R2_BUCKET is not set}" "${RESULTS_PREFIX:-runs}"
  fi
}

# http_ok URL → exit 0 if the URL answers 2xx within 3 s.
http_ok() {
  python3 - "$1" <<'PY'
import sys, urllib.request
try:
    with urllib.request.urlopen(sys.argv[1], timeout=3) as r:
        sys.exit(0 if 200 <= r.status < 300 else 1)
except Exception:
    sys.exit(1)
PY
}

# wait_http URL TIMEOUT_S [PID] → waits for 2xx; fails early if PID dies.
wait_http() {
  local url="$1" timeout="$2" pid="${3:-}" start
  start=$(date +%s)
  until http_ok "$url"; do
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      log "process $pid exited while waiting for $url"
      return 1
    fi
    if (($(date +%s) - start > timeout)); then
      log "timed out after ${timeout}s waiting for $url"
      return 1
    fi
    sleep 2
  done
}

# stop_pid_file FILE → stops the process group started by `setsid` and removes the file.
stop_pid_file() {
  local file="$1" pid
  [[ -f "$file" ]] || return 0
  pid=$(cat "$file")
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 60); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  rm -f "$file"
}

# config_model FILE → the `model:` value of a vLLM config file.
config_model() { sed -n 's/^model:[[:space:]]*\([^[:space:]#]*\).*/\1/p' "$1" | head -n1; }

# gpu_tag → short tag of the first GPU for labels: "NVIDIA GeForce RTX 3090" → rtx3090,
# "NVIDIA A100-SXM4-80GB" → a100-80gb, "NVIDIA H100 80GB HBM3" → h100-80gb.
gpu_tag() {
  local name
  name="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n1)"
  if [[ -z "$name" ]]; then
    echo nogpu
    return
  fi
  echo "$name" | tr '[:upper:]-' '[:lower:] ' | awk '{
    tag = ""; mem = ""
    for (i = 1; i <= NF; i++) {
      w = $i
      if (w ~ /^(nvidia|geforce|pcie|nvl|sxm[0-9]*|hbm[0-9]*e?)$/) continue
      if (w ~ /^[0-9]+gb$/) { mem = "-" w; continue }
      tag = tag w
    }
    gsub(/[^a-z0-9]/, "", tag); print tag mem
  }'
}

# smoke_test BASE_URL MODEL → one streaming chat request; fails unless tokens arrive.
smoke_test() {
  python3 - "$1" "$2" <<'PY'
import json, sys, time, urllib.request
base, model = sys.argv[1], sys.argv[2]
body = {"model": model, "stream": True, "max_tokens": 32, "temperature": 0,
        "messages": [{"role": "user", "content": "Name three primary colors."}],
        "chat_template_kwargs": {"enable_thinking": False}}
req = urllib.request.Request(f"{base}/v1/chat/completions", data=json.dumps(body).encode(),
                             headers={"content-type": "application/json"})
t0 = time.perf_counter(); ttft = None; text = []
with urllib.request.urlopen(req, timeout=120) as res:
    for raw in res:
        line = raw.decode().strip()
        if not line.startswith("data: ") or line == "data: [DONE]":
            continue
        for choice in json.loads(line[6:]).get("choices", []):
            piece = (choice.get("delta") or {}).get("content")
            if piece:
                ttft = ttft or time.perf_counter() - t0
                text.append(piece)
total = time.perf_counter() - t0
if not text:
    sys.exit("smoke test: no tokens in the stream")
print(f"smoke ok: ttft={ttft * 1000:.0f}ms total={total * 1000:.0f}ms text={''.join(text)!r}")
PY
}

# Variables a launcher forwards into the pod (empty ones are skipped). Secrets among them reach
# the provider's pod settings, which is why every key is dedicated, scoped and revocable.
LAB_POD_VARS=(JOB LABEL LAB_IMAGE MAX_RUNTIME_MIN KEEP_ALIVE SYNC_INTERVAL_S
  CONFIGS PLAN SCENARIOS GATEWAY_PASS CROSSCHECK VLLM_CONFIG
  PROVIDER GPU_PRICE_PER_HOUR_USD HF_TOKEN
  R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_ENDPOINT RESULTS_PREFIX)

# pod_env_json → {"KEY": "value", ...} for runpodctl --env.
pod_env_json() {
  local v
  for v in "${LAB_POD_VARS[@]}"; do
    if [[ -n "${!v:-}" ]]; then printf '%s\0%s\0' "$v" "${!v}"; fi
  done | python3 -c 'import json,sys; p=sys.stdin.buffer.read().split(b"\0")[:-1]; print(json.dumps({p[i].decode(): p[i+1].decode() for i in range(0, len(p), 2)}))'
}

# pod_env_docker → "-e KEY=value ..." for vastai --env (values must not contain spaces).
pod_env_docker() {
  local v out=""
  for v in "${LAB_POD_VARS[@]}"; do
    [[ -n "${!v:-}" ]] || continue
    [[ "${!v}" != *[[:space:]]* ]] || die "$v contains whitespace, which vastai --env cannot pass"
    out+=" -e $v=${!v}"
  done
  printf '%s\n' "${out# }"
}

# redact → the input with values of secret-looking variables replaced by ***.
redact() { sed -E 's/((TOKEN|KEY|SECRET)[A-Z_]*"?[:=] ?"?)[^" ,}]+/\1***/g'; }

# print_cmd ARGS... → the command, shell-quoted, with secret values redacted argument by argument.
print_cmd() {
  local a out=()
  for a in "$@"; do out+=("$(printf '%s' "$a" | redact)"); done
  printf '%q ' "${out[@]}"
  echo
}

# launch_checks → fails unless the settings every launch needs are present.
launch_checks() {
  local v
  for v in LAB_IMAGE R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
    [[ -n "${!v:-}" ]] || die "$v is not set (see .env.example)"
  done
  [[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || die "LABEL may contain only letters, digits, '.', '_' and '-'"
  [[ "$JOB" != gpu-session || -n "${CONFIGS:-}" ]] || die "JOB=gpu-session needs CONFIGS"
}

# plan_estimate JOB [PLAN] [CONFIGS] [SCENARIOS] → worst-case minutes of work inside the pod.
# Every ladder and open-loop point is assumed to run in full. A closed-loop point lasts at least
# maxSeconds, but also until minRequests have completed: at concurrency 1 with 1000-token answers
# that is 30 requests × ~40 s, a quarter of an hour (the first 9B session ran 28% over an estimate
# that ignored this). Request time = 1 s + outputTokens × 40 ms. Image pull is not included.
plan_estimate() {
  python3 - "$@" <<'PY'
import math, os, re, sys
args = sys.argv[1:] + [""] * 4
job, plan, configs, override = args[:4]
if job == "rehearsal":
    plan, nconf = plan or "bench/plans/rehearsal.yaml", 1
else:
    plan = plan or "bench/plans/gpu.yaml"
    nconf = max(1, len([c for c in configs.split(",") if c.strip()]))
text = open(plan).read()
def items(src, key):
    m = re.search(rf"^\s*{key}:\s*\[([^\]]*)\]", src, re.M)
    return [x.strip() for x in m.group(1).split(",") if x.strip()] if m else []
def num(src, key, default):
    m = re.search(rf"^\s*{key}:\s*([0-9.]+)", src, re.M)
    return float(m.group(1)) if m else default
warmup, max_s = num(text, "warmupSeconds", 30), num(text, "maxSeconds", 90)
cooldown, min_req = num(text, "cooldownSeconds", 5), num(text, "minRequests", 30)
ladder = [int(c) for c in items(text, "concurrency")]
fractions = items(text, "fractions")
def request_s(name):
    path = f"bench/scenarios/{name}.yaml"
    src = open(path).read() if os.path.exists(path) else ""
    return 1 + num(src, "outputTokens", 256) * 0.04
def scenario_s(name):
    e2e = request_s(name)
    closed = sum(warmup + max(max_s, math.ceil(min_req / c) * e2e) + e2e + cooldown for c in ladder)
    opened = len(fractions) * (warmup + max_s + e2e + cooldown)
    return 75 + closed + opened  # 75 s: vLLM restart before each scenario
scenarios = [s for s in override.split(",") if s.strip()] or items(text, "scenarios")
first_start, crosscheck = 300, 120  # model download + first start; one bench point
gateway = scenario_s("chat") if os.environ.get("GATEWAY_PASS", "1") != "0" else 0
total = nconf * (first_start + sum(scenario_s(s) for s in scenarios) + gateway + crosscheck)
print(math.ceil(total / 60))
PY
}
