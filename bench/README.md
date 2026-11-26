# Benchmarks

How a measurement campaign runs, end to end. Definitions and rules live in the
[methodology](../docs/methodology.md); the tool choice in [ADR-0005](../docs/adr/0005-load-generator.md).

```
bench/run_matrix.sh ─┬─ collect_env.py        → env.json (GPU, driver, PCIe, server version, price)
                     ├─ nvidia-smi -l 1        → nvidia-smi.csv (clocks, power, temperature)
                     ├─ loadgen matrix         → points/<scenario>/<point>/{requests.jsonl.gz, point.json, metrics-*.prom}
                     └─ analyze.py report      → analysis/{report.md, summary.csv, capacity.csv, <scenario>.png}
```

## Layout

| Path | What |
|---|---|
| `scenarios/*.yaml` | Workload profiles: prompt/output length, sampling, SLO (`chat`, `rag`, `longgen`, `sharegpt`, `rag-shared-prefix`, `smoke`) |
| `plans/*.yaml` | Campaigns: target, scenarios, concurrency ladder, open-loop fractions, point duration, extra request fields |
| `run_matrix.sh` | One campaign end to end |
| `collect_env.py` | Environment fingerprint (stdlib only, runs on the pod) |
| `crosscheck.sh` | The same point measured with `vllm bench serve` |
| `prepare_sharegpt.py` | Builds `data/sharegpt.jsonl` for the realistic profile |
| `analyze/analyze.py` | Tables, capacity under SLO, $/1M tokens, charts, run comparison, cross-check |
| `analyze/exp2.py` | Experiment 2: break-even load U*, hosted-API latency and billed cost, quality with paired tests |
| `api/providers.yaml`, `api/run_api.py` | Experiment 2: hosted endpoints (dated prices and quantization) and one loadgen run per endpoint |
| `eval/` | Experiment 2: quality runs with lm-evaluation-harness (`run_eval.py`, the `lab-chat` model, the fixed MMLU-Pro sample) |
| `tests/` | pytest for the analysis |

## Running

```bash
# GPU pod, vLLM on :8000
export PROVIDER=vast GPU_PRICE_PER_HOUR_USD=0.42 VLLM_CONFIG=serving/configs/qwen3.5-9b.4090.yaml
bench/run_matrix.sh --plan bench/plans/gpu.yaml --label 4090_qwen3.5-9b_bf16 --model Qwen/Qwen3.5-9B

# the same through the gateway (:8080), then the overhead (methodology §7)
bench/run_matrix.sh --plan bench/plans/gpu.yaml --label 4090_qwen3.5-9b_bf16_gw \
  --model Qwen/Qwen3.5-9B --target http://127.0.0.1:8080 --scenarios chat
uv run --package bench python bench/analyze/analyze.py compare results/raw/<direct> results/raw/<gateway>

# cross-check one point with vLLM's own benchmark
bench/crosscheck.sh results/raw/<run> Qwen/Qwen3.5-9B 16 512 256
uv run --package bench python bench/analyze/analyze.py crosscheck results/raw/<run>
```

Locally, without a GPU:

```bash
MOCK_SIM=1 pnpm dev:mock                       # fake vLLM that queues, prefills and slows down like a GPU
bench/run_matrix.sh --plan bench/plans/local-mock.yaml --label sim-direct

# or llama.cpp's llama-server through the gateway (see the comments in plans/local-llama.yaml)
bench/run_matrix.sh --plan bench/plans/local-llama.yaml --label m3max_llamacpp
```

Runs of plans named `local-*` go to `results/local/` (git-ignored); `results/raw/` holds only real
GPU campaigns. `env.json` describes the inference server itself (the plan's `tokenizeUrl`, else its
`target`; override with `SERVER_URL`).

Any plan field can be overridden on the command line: `--target`, `--model`, `--scenarios a,b`,
`--metrics-url`, `--tokenize-url`, `--out`.

## Experiment 2: hosted APIs and quality

Rules: [methodology §11](../docs/methodology.md#11-experiment-2-hosted-apis-and-quality),
choices: [ADR-0007](../docs/adr/0007-quality-and-api-comparison.md). Python parts need the `eval`
dependency group: `uv sync --all-packages --group eval`.

```bash
# once, before the first paid run (needs huggingface.co): draw and commit the MMLU-Pro sample
uv run --package bench --group eval python bench/eval/make_mmlu_pro_sample.py

# hosted APIs: every endpoint in api/providers.yaml, one daypart (morning | day | evening)
OPENROUTER_API_KEY=... uv run --package bench python bench/api/run_api.py --daypart morning

# quality of one hosted endpoint (our own variants run on a pod: infra/jobs/eval-session.sh)
OPENROUTER_API_KEY=... uv run --package bench --group eval python bench/eval/run_eval.py \
  --url https://openrouter.ai/api/v1/chat/completions --key-env OPENROUTER_API_KEY \
  --model qwen/qwen3.5-27b --label api_deepinfra-fp8_27b --concurrency 8 \
  --extra-body '{"provider":{"only":["deepinfra/fp8"],"allow_fallbacks":false},"reasoning":{"effort":"none"}}'

# analysis → results/exp2/
uv run --package bench python bench/analyze/exp2.py breakeven
uv run --package bench python bench/analyze/exp2.py api results/raw/*_api_*
uv run --package bench python bench/analyze/exp2.py quality results/eval/* --ref <our BF16 eval dir>
```

Dry run of the API path without a key: `pnpm dev:mock:sim`, then the command in the header of
`plans/local-api.yaml`.

## Reading a report

- **TTFT** is measured to the first chunk that carries a token, not to the first SSE event.
- **TPOT** = (E2E − TTFT) / (output tokens − 1) per request; percentiles across requests.
- **ITL** percentiles are over all inter-token gaps of the point.
- **Throughput** is measured in the steady-state window: from the end of the warm-up to the start of
  the last measured request, when every worker is busy. Above the server's batch capacity it
  plateaus instead of dropping — the knee shows up in TTFT (queueing), not in tokens/s.
- **Goodput** counts only requests that individually met TTFT and TPOT targets.
- **Capacity** is the highest load whose p95 TTFT, p95 TPOT and error rate meet the SLO and whose
  client was not the bottleneck; **$/1M tokens** is the GPU price per hour divided by the tokens per
  hour at that load (100 % utilization assumed).
- p99 is shown only with ≥ 300 requests in the point (ITL: ≥ 300 gaps).

## ShareGPT data

```bash
hf download anon8231489123/ShareGPT_Vicuna_unfiltered ShareGPT_V3_unfiltered_cleaned_split.json \
  --repo-type dataset --local-dir bench/data
python3 bench/prepare_sharegpt.py bench/data/ShareGPT_V3_unfiltered_cleaned_split.json
```

`bench/data/` is git-ignored; the dataset is downloaded where it is used.
