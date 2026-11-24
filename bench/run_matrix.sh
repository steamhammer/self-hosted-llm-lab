#!/usr/bin/env bash
# One benchmark campaign: environment fingerprint → GPU sampler → loadgen matrix → analysis.
#
#   bench/run_matrix.sh --plan bench/plans/gpu.yaml --label 4090_qwen3.5-9b_bf16 [loadgen options]
#
# Environment (optional): PROVIDER, REGION, GPU_PRICE_PER_HOUR_USD, VLLM_IMAGE, VLLM_CONFIG,
# SERVER_URL (inference server for env.json; default: the plan's tokenizeUrl, else its target),
# OUT (output directory; default results/raw/..., or results/local/... for plans named local-*).
set -euo pipefail
cd "$(dirname "$0")/.."

PLAN="" LABEL=""
ARGS=()
while (($#)); do
  case "$1" in
    --plan) PLAN="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
[[ -n "$PLAN" && -n "$LABEL" ]] || { echo "usage: $0 --plan <file> --label <tag> [loadgen options]" >&2; exit 2; }

# Plan value of a top-level "key: value" line (plans are flat YAML at the top level).
plan_value() { sed -n "s/^$1:[[:space:]]*\([^[:space:]#]*\).*/\1/p" "$PLAN" | head -n1; }

# Local dry runs (plans named local-*) never land in results/raw, which holds only real GPU runs.
if [[ "$(plan_value name)" == local-* ]]; then ROOT=results/local; else ROOT=results/raw; fi
OUT="${OUT:-$ROOT/$(date +%F)_${LABEL}_$(date +%H%M%S)}"
mkdir -p "$OUT"

# The inference server itself (not the gateway), so env.json records its version and build.
SERVER_URL="${SERVER_URL:-$(plan_value tokenizeUrl)}"
SERVER_URL="${SERVER_URL:-$(plan_value target)}"
SERVER_URL="$SERVER_URL" python3 bench/collect_env.py --out "$OUT/env.json"
if [[ -n "${VLLM_CONFIG:-}" && -f "$VLLM_CONFIG" ]]; then cp "$VLLM_CONFIG" "$OUT/vllm-config.yaml"; fi

# Clocks, power, temperature and memory once per second (methodology §9: throttling).
if command -v nvidia-smi >/dev/null; then
  nvidia-smi --query-gpu=timestamp,clocks.sm,clocks.mem,power.draw,temperature.gpu,utilization.gpu,memory.used \
    --format=csv,nounits -l 1 >"$OUT/nvidia-smi.csv" &
  SAMPLER=$!
  trap 'kill "$SAMPLER" 2>/dev/null || true' EXIT
fi

node loadgen/src/cli.ts matrix --plan "$PLAN" --label "$LABEL" --out "$OUT" ${ARGS[@]+"${ARGS[@]}"}

if command -v uv >/dev/null; then
  uv run --package bench python bench/analyze/analyze.py report "$OUT"
else
  echo "uv not found: analyse later with 'uv run --package bench python bench/analyze/analyze.py report $OUT'"
fi
