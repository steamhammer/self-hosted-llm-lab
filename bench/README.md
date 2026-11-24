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
