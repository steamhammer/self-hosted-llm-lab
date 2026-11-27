# Benchmark methodology

**Version:** 1.3 (frozen) · **Status:** 1.1 frozen 2026-11-24, before the first paid GPU run;
§11 (experiment 2) added in 1.2 on 2026-11-26, before its first paid run; 1.3 changes analysis only.
Every result in this repository is tagged with the methodology version it was measured under.
Changes after the freeze go to the [changelog](#changelog) with a date and a reason.

## 1. Goal

Measure, for each *model × quantization × GPU* configuration served by [vLLM](https://docs.vllm.ai):

1. latency a user would feel (TTFT, TPOT, end-to-end);
2. throughput the hardware delivers (tokens/s, requests/s);
3. **capacity** — the highest load that still meets the SLO in §5;
4. **cost** per 1M tokens at that capacity;
5. the overhead added by the API gateway.

Experiment 2 (§11) adds what the first one left out: the same models behind hosted APIs, and the
quality each quantization keeps.

Non-goals: multi-GPU / tensor-parallel serving, training.

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

## 11. Experiment 2: hosted APIs and quality

Question: when is renting a GPU cheaper than paying an API for the same model, and what does a
cheaper quantization cost in answer quality? §1–§10 still hold for everything measured on our own
GPUs; this section adds the API side and the quality runs. Tools and task sets:
[ADR-0007](adr/0007-quality-and-api-comparison.md).

### 11.1 Hosted APIs: latency and billed cost

- **Router and endpoints.** Every API is reached through [OpenRouter](https://openrouter.ai), one
  provider per run, pinned with `provider: {only: [<slug>], allow_fallbacks: false}`
  ([provider routing](https://openrouter.ai/docs/features/provider-routing)). The endpoints, their
  declared quantization and their prices are a dated snapshot in
  [`bench/api/providers.yaml`](../bench/api/providers.yaml), taken from OpenRouter's public
  endpoint lists. One closed model of the same price class is added for reference.
- **Workload.** The `chat` and `rag` scenarios with the same random-word prompts. Hosted APIs have
  no `/tokenize`, so prompt length uses the ratio measured with vLLM in experiment 1 (1.0 token per
  word for Qwen3.5); the real size still comes from `usage`. They also cannot force the output
  length (`ignore_eos` is not sent), so every prompt starts with a one-line request for a long
  answer, and TPOT and cost are computed from the tokens actually returned.
- **Load.** Closed loop at 1, 2, 4 and 8 concurrent requests, all four points always (no early
  stop), 30–60 measured requests per point. We measure what a user of the API sees at low load,
  not the provider's capacity.
- **Network.** The client runs on a laptop, so API latency includes the internet round trip; our
  own numbers (§4) do not. The comparison states this next to every chart.
- **Time of day.** Three runs per endpoint: US morning, day and evening, because a shared provider
  queue can vary in a way our own GPU does not.
- **Reasoning off.** Requests carry `reasoning: {effort: none}`
  ([reasoning tokens](https://openrouter.ai/docs/use-cases/reasoning-tokens)). Every record keeps
  the reasoning chunks and `reasoning_tokens` it saw; an endpoint that ignores the setting is
  reported separately, not averaged in.
- **Errors.** HTTP 429 (rate limit) is counted apart from other errors and does not count against
  the provider's latency, but is reported.
- **Cost.** Taken from the billed `usage.cost` of every response
  ([usage accounting](https://openrouter.ai/docs/use-cases/usage-accounting)) and compared with
  the price list.

### 11.2 Break-even load

Our $/1M output tokens (§6) already includes processing the prompt; an API bills input and output
separately. For a scenario with *r* input tokens per output token (chat 512/256 = 2, rag
4000/300 ≈ 13.3), the API price in our unit is:

```
API $/1M output (scenario) = r × input price + output price
U* = our $/1M output at capacity ÷ API $/1M output (scenario)
```

U* is the share of time a rented GPU must run at capacity to cost the same as the API. Above 100%
it never pays off. `bench/analyze/exp2.py breakeven` computes it from every run's `capacity.csv`.

U* is reported for both capacities of §5: **closed loop** (concurrency ladder), the conservative
figure, and **open loop** (Poisson rate sweep), closer to real traffic. The two can differ in either
direction: on H100 FP8 chat, synchronized prefills push closed-loop TTFT over the SLO at c=32 while
Poisson arrivals hold it at 9 req/s (about 2.3× the closed-loop throughput); on L40S and for rag,
Poisson queueing breaks TTFT earlier than the ladder does. The `bound` column says whether a heavier
point of the same sweep broke the SLO (`ceiling`) or not (`SLO never broke`): then capacity is only a
lower bound and U* an upper bound ("at most"). A sweep can be widened past 90% with a plan such as
[`bench/plans/gpu-wide-openloop.yaml`](../bench/plans/gpu-wide-openloop.yaml) (fractions 0.25–1.5).
When a configuration is re-run, the latest run is used.

### 11.3 Quality

- **Tool.** [lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) 0.4.13,
  pinned, through its chat-completions client, with the chat template applied by the server and
  few-shot examples as earlier turns. The same client and command run against our vLLM and every
  API, so a difference in scores comes from the model and how it is served, not from the tool.
- **Settings.** Temperature 0, thinking off, default generation limit 1,024 tokens (MMLU-Pro sets
  2,048, IFEval 1,280). For eval runs vLLM gets `--max-model-len 16384` so long few-shot prompts
  fit; this changes no weights or kernels.
- **Task sets** (answers are scored by rules, no judge model):

  | Set | Questions | Score |
  |---|---|---|
  | GSM8K (`gsm8k_cot_llama`, 8-shot) | 1,319 | exact match of the last number (`flexible-extract`) |
  | MMLU-Pro (5-shot, chain of thought) | 1,400: 100 per subject, fixed sample, seed 2026 ([`bench/eval/mmlu_pro_sample.json`](../bench/eval/mmlu_pro_sample.json)) | exact match of the chosen letter |
  | IFEval | 541 | prompt-level strict accuracy |

- **Variants.** Our Qwen3.5-27B in BF16, FP8 and GPTQ-Int4, all on one H100 (quality does not
  depend on the card; the Int4 kernel on Hopper may round slightly differently from Ada, which is
  stated as a limitation); our Qwen3.5-9B BF16 on an RTX 4090; the API endpoints of §11.1.
- **Statistics.** Every variant answers the same questions, so comparisons are paired against our
  BF16: the difference in accuracy with a 95% paired bootstrap interval (10,000 resamples over
  questions) and McNemar's exact test on the questions where the two disagree. Each variant is
  also scored on its own with a 95% bootstrap interval. A difference whose interval covers zero is
  reported as "no measurable difference", which is a result, not a failure.
- **Same answer, not only same score.** For every pair: the share of identical extracted answers,
  the share of identical full responses, and where the responses start to differ. Prompts are
  checked to be identical by their hash.
- **Groups for the "math vs knowledge" question.** GSM8K; MMLU-Pro math, physics, chemistry and
  engineering ("quantitative"); the other ten MMLU-Pro subjects ("knowledge"); IFEval.
- **Rehearsal before paid runs.** `--limit 20` on a 0.8B model, then 30 answers per set read by
  hand to confirm the extraction matches Qwen3.5's format. Extraction problems would lower scores
  for reasons unrelated to the model.
- **Optional judge.** A pairwise LLM-as-judge comparison on 100 chat and RAG prompts is prepared
  but run only if the task sets show a difference that needs explaining on realistic prompts.

### 11.4 Raw data

```
results/raw/<date>_api_<endpoint>_<daypart>_<time>/      # loadgen layout (§10); env.json describes
                                                        # the endpoint and the price snapshot;
                                                        # each record has api: {provider, cost,
                                                        # reasoningTokens, reasoningChunks, ...}
results/eval/<date>_<label>/ or <session>/…_eval_<gpu>_<config>_<time>/
  eval.json             # endpoint, tasks, sample file, lm-eval version, wall time
  results.json          # lm-eval scores
  samples/<task>.jsonl.gz   # every question: prompt hash, raw response, extracted answer, score
  usage.jsonl           # per response: tokens, reasoning tokens, billed cost, provider
```

## Changelog

| Date | Version | Change | Reason |
|---|---|---|---|
| 2026-11-24 | 1.0 | Initial version, frozen | — |
| 2026-11-24 | 1.1 | Own load generator (loadgen) instead of GuideLLM as the primary tool, `vllm bench serve` as cross-check (§4); open-loop rates as fractions of the ladder's best rate (§4.1); client check via event-loop utilization (§4.3); steady-state throughput window (§5); word-based prompts calibrated with `/tokenize` (§3.1); raw layout (§10) | Same tool and output format against vLLM, gateway, mock and llama.cpp; per-request raw data for our own percentiles and goodput; no dependency on third-party output formats. Changed before any paid run, so no results are affected. |
| 2026-11-26 | 1.2 | §11: hosted APIs through OpenRouter, break-even load U*, quality with lm-evaluation-harness; §1 no longer lists quality as a non-goal | Experiment 2. Added before its first paid run; §1–§10 unchanged, so experiment 1 results are unaffected. |
| 2026-11-27 | 1.3 | §11.2: U* for both closed- and open-loop capacity, with a `bound` flag; re-run of H100 FP8 chat with open-loop fractions 0.25–1.5 | The standard sweep (25–90%) never broke the SLO on H100 FP8 chat, so its open-loop capacity was only a lower bound; the wide re-run found the ceiling at 8.94 req/s, 2.3× the closed-loop throughput. Analysis only: no measurement procedure changed, earlier runs stay valid |
