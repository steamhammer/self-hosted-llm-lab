# Benchmark methodology

**Version:** 1.1 (frozen) · **Status:** frozen 2026-11-24, before the first paid GPU run.
Every result in this repository is tagged with the methodology version it was measured under.
Changes after the freeze go to the [changelog](#changelog) with a date and a reason.

## 1. Goal

Measure, for each *model × quantization × GPU* configuration served by [vLLM](https://docs.vllm.ai):

1. latency a user would feel (TTFT, TPOT, end-to-end);
2. throughput the hardware delivers (tokens/s, requests/s);
3. **capacity** — the highest load that still meets the SLO in §5;
4. **cost** per 1M tokens at that capacity;
5. the overhead added by the API gateway.

Non-goals: model quality evaluation, multi-GPU / tensor-parallel serving, training.

## 2. System under test

Recorded for every run in `results/raw/<run>/env.json` by `bench/collect_env.sh`:

| Field | Example |
|---|---|
| Provider, region, price/hour | Vast.ai, EU, $0.42 |
| GPU model and **variant** (SXM / PCIe), VRAM, power limit, PCIe gen × width | H100 SXM 80 GB, 700 W, Gen5 x16 |
| Driver, CUDA | `nvidia-smi -q` |
| vLLM version and image digest | `vllm/vllm-openai@sha256:…` |
| Model ID, revision (commit SHA), quantization, KV-cache dtype | `Qwen/Qwen3.5-9B@<sha>`, BF16, auto |
| Full vLLM config | copy of `serving/configs/<file>.yaml` |
| Host CPU, RAM | `lscpu`, `free -g` |
| Methodology version | 1.1 |

The vLLM version is pinned once for the whole campaign. A version change invalidates comparisons and
requires re-running the baseline (4090 · Qwen3.5-9B · chat profile).

## 3. Workloads

All requests go to the OpenAI-compatible `/v1/chat/completions` endpoint with streaming on and
`stream_options.include_usage = true`. Token counts are taken from the server-reported `usage`,
never estimated from characters.

### 3.1 Synthetic profiles

| Profile | Input tokens | Output tokens | Models a… |
|---|---|---|---|
| `chat` | 512 | 256 | chat assistant turn |
| `rag` | 4000 | 300 | retrieval-augmented answer, prefill-heavy |
| `longgen` | 200 | 1000 | long generation, decode-heavy |

- Prompts are random sequences of common English words. Their length comes from a tokens-per-word
  ratio measured once per run with the server's own tokenizer (`POST /tokenize`); the actual prompt
  size of every request is taken from `usage.prompt_tokens`, not assumed.
- Output length is fixed with `max_tokens` = target and `ignore_eos = true`.
- Every prompt is unique (seeded RNG, seed recorded); **no shared prefix**, so prefix caching
  cannot inflate results. Prefix caching is studied separately (§3.3).

### 3.2 Realistic profile

`sharegpt`: conversations from [ShareGPT_Vicuna_unfiltered](https://huggingface.co/datasets/anon8231489123/ShareGPT_Vicuna_unfiltered),
natural input/output length distribution, natural EOS. Used for headline numbers and for anything
whose speed depends on content — in particular **speculative decoding (MTP)**, whose acceptance rate is
meaningless on random-token prompts.

### 3.3 Feature experiments

| Experiment | Workload |
|---|---|
| Prefix caching on/off | `rag` with a shared 3000-token system prefix + unique 1000-token tail |
| MTP speculative decoding | `sharegpt` only |

### 3.4 Generation settings

- Thinking/reasoning mode **disabled** via the chat template; the exact flag is recorded in the config.
- `temperature = 0` for synthetic profiles; `temperature = 0.7`, `top_p = 0.8` for `sharegpt`.
- Image inputs disabled (Qwen3.5 is multimodal; vision is out of scope).

## 4. Load generation

Primary tool: [`loadgen/`](../loadgen/) — this repository's own load generator
([ADR-0005](adr/0005-load-generator.md)). It records every request (TTFT, every inter-token gap, E2E,
usage), so all statistics are computed by [`bench/analyze`](../bench/analyze/) from raw data, and it
behaves identically against vLLM, the gateway, the mock upstream and llama.cpp.
Cross-check: one point per GPU is repeated with [`vllm bench serve`](https://docs.vllm.ai/en/stable/benchmarking/cli/)
(`bench/crosscheck.sh`); loadgen and vLLM's numbers must agree within 10%, otherwise the run is investigated.
The load generator runs **on the same machine** as the server (localhost), so network latency is excluded;
gateway measurements in §7 add only the gateway hop.

### 4.1 Load patterns

1. **Closed loop (concurrency ladder)** — a fixed number of in-flight requests:
   1, 2, 4, 8, 16, 32, 64, 128. Stop climbing after two consecutive points violate the SLO (§5.1,
   error rate included).
2. **Open loop (rate sweep)** — Poisson arrivals at 25%, 50%, 75% and 90% of the highest request rate
   the ladder reached. Open loop is what exposes queueing and tail latency; closed loop alone
   understates p99 because clients wait for each other.

### 4.2 Duration per load point

- Warm-up: 30 s or 20 completed requests, whichever comes first; requests *started* during the
  warm-up are discarded (open loop: arrivals in the first 30 s).
- Measurement: until 300 completed requests or 90 s, whichever comes first; at least 30 requests.
- p99 is reported only when n ≥ 300; otherwise shown as `n/a (n=…)`.
- The server is restarted between profiles to reset caches; within a ladder, the seed changes per point.

### 4.3 Client sanity

If the load generator's event loop is busy more than 80% of a point's wall time
(`performance.eventLoopUtilization()`; loadgen runs on one Node.js thread, so this is its CPU
saturation), the point is invalid — the client, not the GPU, was the bottleneck. Invalid points are
marked in the report, excluded from capacity, and re-run with fewer concurrent streams per client.

## 5. Metrics

Measured client-side, per request:

| Metric | Definition |
|---|---|
| **TTFT** | request sent → first content token received |
| **ITL** | time between consecutive streamed tokens |
| **TPOT** | (E2E − TTFT) / (output_tokens − 1) |
| **E2E** | request sent → last token received |

Aggregated per load point:

| Metric | Definition |
|---|---|
| Percentiles | p50, p90, p95, p99 of TTFT, TPOT, E2E |
| Output throughput | output tokens emitted inside the **steady-state window** / window length (tokens/s). Window = end of warm-up → start of the last measured request, i.e. while the load was fully applied; token times are rebuilt from start + TTFT + inter-token gaps, so ramp-down does not dilute the rate |
| Total throughput | output throughput + prompt tokens of requests whose prefill finished inside the window |
| Request throughput | requests completed inside the window / window length |
| Error rate | failed or timed-out requests / all requests |
| **Goodput** | request throughput × share of requests that individually met the TTFT and TPOT targets |

Server-side, scraped from vLLM `/metrics` at the start and end of every point: KV-cache usage,
running/waiting requests, preemptions. Exact metric names are taken from the pinned vLLM version.

### 5.1 SLO (interactive)

| Profile | TTFT p95 | TPOT p95 | Error rate |
|---|---|---|---|
| `chat`, `longgen`, `sharegpt` | ≤ 1.0 s | ≤ 50 ms (≈ 20 tokens/s per user) | < 0.5% |
| `rag` | ≤ 2.0 s (longer prefill is expected) | ≤ 50 ms | < 0.5% |

**Capacity** = the highest concurrency (closed loop) and the highest request rate (open loop) at which
all three SLO conditions hold.

## 6. Cost

At the capacity point:

```
$/1M output tokens = price_per_hour / (output_tokens_per_s × 3600) × 1 000 000
$/1M total tokens  = price_per_hour / (total_tokens_per_s  × 3600) × 1 000 000
```

- `price_per_hour` is the actual rental price at the time of the run (recorded in `env.json`).
- Setup and idle time are excluded from per-token cost but reported separately as **total campaign spend**
  taken from provider invoices.
- Where the same model is available on [OpenRouter](https://openrouter.ai/models), its listed price on the
  measurement date is shown alongside for comparison. Self-hosted cost assumes 100% utilization at the
  capacity point; this assumption is stated next to every comparison.

## 7. Gateway overhead

Same server, same workload (`chat`), two paths: client → vLLM directly, and client → gateway → vLLM.
Measured at concurrency 1 and 32. Reported: Δ TTFT p50/p99 and Δ output throughput.

## 8. Repeatability

- Each **capacity point** (per GPU × model × profile) is measured 3 times, each on a fresh server start.
- Reported value: median; spread: min–max.
- Spread above 10% is flagged and investigated before the number is published.
- Other ladder points are measured once.

## 9. Threats to validity

| Threat | Mitigation |
|---|---|
| Marketplace hosts differ (power limit, PCIe width, CPU) | full environment fingerprint per run; outliers re-run on another host |
| Synthetic prompts are not real traffic | `sharegpt` profile for headline numbers |
| Prefix cache inflating throughput | unique prompts, seed per point, restart between profiles |
| Client-side bottleneck | client CPU check (§4.3) |
| Single-run noise | 3 repeats at capacity points (§8) |
| Thermal / power throttling | `nvidia-smi` clocks and power sampled during the run |
| Results specific to one vLLM version | version pinned and recorded; baseline re-run on any change |
| Qwen3.5 hybrid attention is not a classic transformer | one Llama 3.1 8B baseline run on RTX 4090 for comparison with public numbers |

## 10. Raw data layout

One directory per campaign (`bench/run_matrix.sh`), one sub-directory per load point:

```
results/raw/<YYYY-MM-DD>_<gpu>_<model>_<quant>[_<path>]_<HHMMSS>/
  run.json            # label, target, model, loadgen version, prompt calibration, start/finish
  env.json            # §2 (bench/collect_env.py)
  plan.yaml           # the resolved plan
  scenarios/*.yaml    # the scenarios as used
  vllm-config.yaml    # copy of the config used
  nvidia-smi.csv      # clocks, power, temperature, memory, every 1 s
  points/<scenario>/c<N> | r<rate>/
    point.json        # pattern, value, seed, warm-up end, client ELU, quick summary
    requests.jsonl.gz # one record per request: start, ttft, itl[], e2e, usage, status, error
    metrics-before.prom, metrics-after.prom   # server /metrics snapshots
  analysis/           # bench/analyze: summary.csv, capacity.csv, report.md, charts
  crosscheck/         # vllm bench serve results (bench/crosscheck.sh)
```

## Changelog

| Date | Version | Change | Reason |
|---|---|---|---|
| 2026-11-24 | 1.0 | Initial version, frozen | — |
| 2026-11-24 | 1.1 | Own load generator (loadgen) instead of GuideLLM as the primary tool, `vllm bench serve` as cross-check (§4); open-loop rates as fractions of the ladder's best rate (§4.1); client check via event-loop utilization (§4.3); steady-state throughput window (§5); word-based prompts calibrated with `/tokenize` (§3.1); raw layout (§10) | Same tool and output format against vLLM, gateway, mock and llama.cpp; per-request raw data for our own percentiles and goodput; no dependency on third-party output formats. Changed before any paid run, so no results are affected. |
