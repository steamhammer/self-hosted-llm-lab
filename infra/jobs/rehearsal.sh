#!/usr/bin/env bash
# Rehearsal job (~10 min on a 24 GB card): every stage of a real session once, on a tiny model.
#   1. vLLM starts from a config file and answers /health
#   2. the gateway starts next to it; a streaming request goes through end to end
#   3. a short loadgen matrix runs directly against vLLM (with the per-scenario restart hook)
#   4. the same matrix runs through the gateway (overhead check)
#   5. vLLM's own benchmark cross-checks one point
# Run by infra/bootstrap.sh, which uploads $LAB_RESULTS and deletes the machine afterwards.
set -euo pipefail
cd "$(dirname "$0")/../.."
. infra/lib.sh

export VLLM_CONFIG="${VLLM_CONFIG:-serving/configs/qwen3.5-0.8b.rehearsal.yaml}"
RESULTS="${LAB_RESULTS:?run me from infra/bootstrap.sh}"
PLAN=bench/plans/rehearsal.yaml
MODEL="$(config_model "$VLLM_CONFIG")"
GPU="$(gpu_tag)"
export SKIP_ANALYZE=1 # analysis runs on the laptop after infra/fetch.sh

log "1/5 vLLM ($VLLM_CONFIG)"
infra/serve.sh start

log "2/5 gateway + streaming smoke test"
infra/gateway.sh start
smoke_test http://127.0.0.1:8080 "$MODEL" | tee "$RESULTS/smoke.txt"

log "3/5 matrix, direct"
DIRECT="$RESULTS/$(date -u +%F)_${GPU}_rehearsal_direct_$(date -u +%H%M%S)"
bench/run_matrix.sh --plan "$PLAN" --label "${GPU}_rehearsal_direct" --model "$MODEL" --out "$DIRECT"

log "4/5 matrix, through the gateway"
bench/run_matrix.sh --plan "$PLAN" --label "${GPU}_rehearsal_gateway" --model "$MODEL" \
  --target http://127.0.0.1:8080 --scenarios chat \
  --out "$RESULTS/$(date -u +%F)_${GPU}_rehearsal_gateway_$(date -u +%H%M%S)"

log "5/5 cross-check with vllm bench serve"
if command -v vllm >/dev/null && [[ "${LAB_FAKE_VLLM:-0}" != 1 ]]; then
  bench/crosscheck.sh "$DIRECT" "$MODEL" 16 512 256 100
else
  log "skipped: no vLLM here"
fi
log "rehearsal done"
