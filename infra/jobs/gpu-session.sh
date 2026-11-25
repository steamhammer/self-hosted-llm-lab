#!/usr/bin/env bash
# Measurement session: the full plan for one or more vLLM configs on the rented GPU.
#
# Env: CONFIGS     comma-separated config names from serving/configs (without .yaml), required
#      PLAN        default bench/plans/gpu.yaml
#      SCENARIOS   optional override of the plan's scenarios, e.g. "chat,rag"
#      GATEWAY_PASS=1  also run the chat scenario through the gateway (default 1)
#      CROSSCHECK=1    one vllm bench serve point per config (default 1)
# A failed config does not stop the others; the job exits non-zero if any failed.
set -euo pipefail
cd "$(dirname "$0")/../.."
. infra/lib.sh

: "${CONFIGS:?CONFIGS is not set, e.g. CONFIGS=qwen3.5-9b.24gb,qwen3.5-27b.fp8}"
RESULTS="${LAB_RESULTS:?run me from infra/bootstrap.sh}"
PLAN="${PLAN:-bench/plans/gpu.yaml}"
GPU="$(gpu_tag)"
export SKIP_ANALYZE=1
failed=()

run_config() {
  local name="$1" model label out
  export VLLM_CONFIG="serving/configs/$name.yaml"
  [[ -f "$VLLM_CONFIG" ]] || {
    log "no such config: $VLLM_CONFIG"
    return 1
  }
  model="$(config_model "$VLLM_CONFIG")"
  label="${GPU}_${name}"
  out="$RESULTS/$(date -u +%F)_${label}_$(date -u +%H%M%S)"
  local extra=()
  [[ -n "${SCENARIOS:-}" ]] && extra+=(--scenarios "$SCENARIOS")

  log "== $name: $model"
  infra/serve.sh start
  bench/run_matrix.sh --plan "$PLAN" --label "$label" --model "$model" --out "$out" ${extra[@]+"${extra[@]}"}

  if [[ "${GATEWAY_PASS:-1}" == 1 ]]; then
    infra/gateway.sh start
    bench/run_matrix.sh --plan "$PLAN" --label "${label}_gateway" --model "$model" \
      --target http://127.0.0.1:8080 --scenarios chat \
      --out "$RESULTS/$(date -u +%F)_${label}_gateway_$(date -u +%H%M%S)"
    infra/gateway.sh stop
  fi
  if [[ "${CROSSCHECK:-1}" == 1 ]] && command -v vllm >/dev/null && [[ "${LAB_FAKE_VLLM:-0}" != 1 ]]; then
    bench/crosscheck.sh "$out" "$model" 16 512 256 300
  fi
  infra/serve.sh stop
}

for name in ${CONFIGS//,/ }; do
  # A subshell outside any `if`, so `set -e` still applies inside run_config.
  set +e
  (
    set -e
    run_config "$name"
  )
  rc=$?
  set -e
  if ((rc != 0)); then
    log "config $name FAILED (exit $rc); continuing with the next one"
    failed+=("$name")
    infra/gateway.sh stop || true
    infra/serve.sh stop || true
  fi
done

if ((${#failed[@]})); then
  log "failed configs: ${failed[*]}"
  exit 1
fi
log "all configs done: $CONFIGS"
