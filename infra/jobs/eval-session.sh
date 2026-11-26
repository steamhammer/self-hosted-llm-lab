#!/usr/bin/env bash
# Quality session (experiment 2, docs/adr/0007): for each vLLM config, the same task sets through
# bench/eval/run_eval.py; optionally one load matrix afterwards with the measurement config.
#
# Env: CONFIGS          comma-separated config names from serving/configs, required
#      EVAL_CONCURRENCY parallel requests to vLLM (default 64; no SLO here, only throughput)
#      EVAL_LIMIT       rehearsal: first N questions of every task instead of the full sets
#      EVAL_VLLM_ARGS   extra vllm serve flags for the eval runs (default --max-model-len 16384:
#                       MMLU-Pro 5-shot prompts plus 2048 generated tokens can pass 8192)
#      MATRIX_CONFIGS   configs that also get a load matrix (e.g. the FP8 chat re-run)
#      MATRIX_PLAN      plan for that matrix (default bench/plans/gpu-wide-openloop.yaml)
# A failed config does not stop the others; the job exits non-zero if any failed.
set -euo pipefail
cd "$(dirname "$0")/../.."
. infra/lib.sh

: "${CONFIGS:?CONFIGS is not set, e.g. CONFIGS=qwen3.5-27b.bf16,qwen3.5-27b.fp8}"
RESULTS="${LAB_RESULTS:?run me from infra/bootstrap.sh}"
GPU="$(gpu_tag)"
EVAL_PY="${EVAL_PY:-/opt/lab-eval/bin/python}"
command -v "$EVAL_PY" >/dev/null || EVAL_PY=python3
export SKIP_ANALYZE=1
failed=()

run_config() {
  local name="$1" model out
  export VLLM_CONFIG="serving/configs/$name.yaml"
  [[ -f "$VLLM_CONFIG" ]] || {
    log "no such config: $VLLM_CONFIG"
    return 1
  }
  model="$(config_model "$VLLM_CONFIG")"
  out="$RESULTS/$(date -u +%F)_eval_${GPU}_${name}_$(date -u +%H%M%S)"

  log "== eval $name: $model"
  VLLM_EXTRA_ARGS="${EVAL_VLLM_ARGS---max-model-len 16384}" infra/serve.sh start
  local extra=()
  [[ -n "${EVAL_LIMIT:-}" ]] && extra+=(--limit "$EVAL_LIMIT")
  "$EVAL_PY" bench/eval/run_eval.py --url http://127.0.0.1:8000/v1/chat/completions \
    --model "$model" --label "${GPU}_${name}" --out "$out" \
    --concurrency "${EVAL_CONCURRENCY:-64}" ${extra[@]+"${extra[@]}"}
  cp "$VLLM_CONFIG" "$out/vllm-config.yaml"
  infra/serve.sh stop

  if [[ ",${MATRIX_CONFIGS:-}," == *",$name,"* ]]; then
    local label="${GPU}_${name}_wide"
    log "== matrix $name (${MATRIX_PLAN:-bench/plans/gpu-wide-openloop.yaml})"
    infra/serve.sh start # the measurement config itself, without the eval flags
    bench/run_matrix.sh --plan "${MATRIX_PLAN:-bench/plans/gpu-wide-openloop.yaml}" \
      --label "$label" --model "$model" \
      --out "$RESULTS/$(date -u +%F)_${label}_$(date -u +%H%M%S)"
    infra/serve.sh stop
  fi
}

for name in ${CONFIGS//,/ }; do
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
    infra/serve.sh stop || true
  fi
done

if ((${#failed[@]})); then
  log "failed configs: ${failed[*]}"
  exit 1
fi
log "all configs done: $CONFIGS"
