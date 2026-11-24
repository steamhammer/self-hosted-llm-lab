# Self-hosted LLM inference lab

Serving open-weight LLMs with [vLLM](https://docs.vllm.ai) on rented GPUs (RTX 4090 → L4 → L40S → A100 → H100),
behind a small production-style API gateway, and measuring what it actually costs and where it breaks.

> **Status:** work in progress — methodology fixed, no measurements yet.

## Questions this repo answers

- Which model and serving software, on which GPU, with which settings?
- Throughput (tokens/s) and latency (TTFT, TPOT, p50/p95/p99) per GPU and quantization.
- How many concurrent requests one GPU holds within a latency SLO, and where it degrades.
- Cost per 1M tokens, compared with hosted API prices.
- One failure, reproduced and written up as a postmortem.

## Results

_Will appear here after the first measurement run._ Raw data: [`results/raw/`](results/raw/).

## Repository layout

| Path | What |
|---|---|
| [`docs/methodology.md`](docs/methodology.md) | How everything is measured — fixed before the first paid run |
| [`docs/adr/`](docs/adr/) | Architecture decision records |
| `serving/configs/` | vLLM configs per model × GPU |
| [`gateway/`](gateway/) | TypeScript API gateway (streaming, timeouts, retries, admission control) |
| `mock-upstream/` | Fake vLLM for deterministic gateway tests |
| [`loadgen/`](loadgen/) | Load generator: per-request TTFT/ITL/E2E, closed and open loop, SLO-aware ladder |
| [`bench/`](bench/) | Scenarios, plans, campaign runner, environment capture, analysis and charts |
| `results/raw/` | Raw benchmark output + environment fingerprint per run |
| `infra/` | Pod bootstrap and provider scripts (RunPod, Vast.ai) |
| `observability/` | Prometheus / Grafana config |
| `asr/` | Optional Whisper experiment |

## Development

Requirements: Node.js 26 LTS, [pnpm](https://pnpm.io), [uv](https://docs.astral.sh/uv/),
[pre-commit](https://pre-commit.com).

```bash
cp .env.example .env   # fill in; never committed
make setup
make help

pnpm test              # gateway, mock and loadgen tests
uv run --package bench pytest bench/tests   # analysis tests
pnpm dev:mock          # fake vLLM on :8000
UPSTREAM_URL=http://127.0.0.1:8000 FORWARD_HEADERS='x-mock-*' pnpm dev:gateway

pnpm dev:mock:sim      # fake vLLM that behaves like a small GPU
bench/run_matrix.sh --plan bench/plans/local-mock.yaml --label sim-direct   # dry-run campaign
```

## License

MIT
