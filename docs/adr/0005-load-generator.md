# 0005. Load generator: own TypeScript tool, vLLM's benchmark as cross-check

- Status: Accepted
- Date: 2026-11-24

## Context

Methodology 1.0 named [GuideLLM](https://github.com/vllm-project/guidellm) and
[`vllm bench serve`](https://docs.vllm.ai/en/stable/benchmarking/cli/) as the load tools. Building the
pipeline showed four problems:

- `vllm bench serve` ships inside vLLM and needs its CUDA stack, so the pipeline cannot be developed
  or dry-run on a laptop against the mock upstream or llama.cpp.
- Both tools report aggregates in their own, version-dependent JSON. Goodput against our SLO, p99
  gating by sample count and the direct-vs-gateway comparison need per-request data.
- The methodology requires a client-saturation check and strict control over prompt uniqueness
  (prefix caching); neither is exposed uniformly by the two tools.
- The same measurement has to run against vLLM, the gateway, the mock and llama.cpp; otherwise
  comparisons mix tools.

## Decision

A small load generator in TypeScript, [`loadgen/`](../../loadgen/):

- records every request: start, TTFT (to the first *token*, not the first chunk), every
  inter-token gap, E2E, server-reported usage, status and error code — gzipped JSONL per point;
- closed loop (concurrency ladder with early stop on SLO violations) and open loop (Poisson
  arrivals at fractions of the best rate the ladder reached);
- word-based prompts whose length is calibrated once per run against the server's `/tokenize`,
  unique per request from the first token (optionally with a shared prefix);
- measures its own event-loop utilization to flag client-bound points.

Statistics are computed only in [`bench/analyze`](../../bench/analyze/) (Python, pandas) from the raw
records. `vllm bench serve` stays as an independent **cross-check** of one point per GPU
(`bench/crosscheck.sh`, `analyze.py crosscheck`); agreement within 10% is expected.

## Alternatives considered

| Option | Why not |
|---|---|
| GuideLLM as primary | Good SLO-aware tool, but aggregates only in its own format and Python-heavy installation; kept out to avoid two toolchains measuring the same thing. |
| `vllm bench serve` as primary | The reference for vLLM, but unavailable off-GPU and aggregate-only. Used as the cross-check. |
| [k6](https://k6.io) / [Locust](https://locust.io) | General HTTP load tools: no notion of tokens, TTFT or inter-token latency without writing most of the logic anyway. |

## Consequences

- Our own tool needs its own validation: unit and integration tests against the mock, and the
  cross-check against `vllm bench serve` on every GPU.
- One Node.js process is single-threaded; at very high concurrency it can become the bottleneck.
  The event-loop check makes this visible; the remedy is fewer streams per client process.
- Methodology bumped to 1.1 before any paid run, so no results are affected.
