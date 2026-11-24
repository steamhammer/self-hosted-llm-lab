#!/usr/bin/env bash
# Cross-check one loadgen point with vLLM's own benchmark (methodology §4): same server, same
# input/output lengths, same concurrency. Runs where `vllm` is installed (the GPU pod).
#
#   bench/crosscheck.sh <run_dir> <model> [concurrency=16] [input=512] [output=256] [prompts=300]
#
# Then: uv run --package bench python bench/analyze/analyze.py crosscheck <run_dir>
# Flags match vLLM's `vllm bench serve`; re-check them with --help for the pinned vLLM version.
set -euo pipefail

RUN_DIR="${1:?run dir}" MODEL="${2:?model}"
C="${3:-16}" IN="${4:-512}" OUT_LEN="${5:-256}" N="${6:-300}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8000}"

mkdir -p "$RUN_DIR/crosscheck"
vllm bench serve \
  --backend openai-chat \
  --base-url "$BASE_URL" \
  --endpoint /v1/chat/completions \
  --model "$MODEL" \
  --dataset-name random \
  --random-input-len "$IN" \
  --random-output-len "$OUT_LEN" \
  --ignore-eos \
  --num-prompts "$N" \
  --max-concurrency "$C" \
  --seed "$RANDOM" \
  --percentile-metrics ttft,tpot,itl,e2el \
  --metric-percentiles 50,95,99 \
  --save-result \
  --result-dir "$RUN_DIR/crosscheck" \
  --result-filename "vllm-bench_c${C}_${IN}x${OUT_LEN}.json"
