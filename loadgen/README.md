# loadgen

Load generator for OpenAI-compatible LLM servers (vLLM, llama.cpp, the gateway, the mock).
Why it exists: [ADR-0005](../docs/adr/0005-load-generator.md). How it is used: [bench/README.md](../bench/README.md).

```bash
node loadgen/src/cli.ts matrix --plan bench/plans/gpu.yaml --label 4090_qwen3.5-9b_bf16 \
  [--target URL] [--model ID] [--scenarios a,b] [--metrics-url URL] [--tokenize-url URL] [--out DIR]
```

## What it does

For each scenario of the plan:

1. Optional `hooks.beforeScenario` shell command (e.g. restart vLLM), then waits for `readyUrl`.
2. **Concurrency ladder** (closed loop): N workers, each sending its next request when the previous
   one finishes. Stops after `stopAfterViolations` consecutive points that miss the scenario's SLO.
3. **Open loop**: Poisson arrivals at the configured fractions of the best request rate the ladder
   reached — this exposes queueing that the closed loop hides.

Per point it snapshots the server's `/metrics` before and after, and writes `point.json` and
`requests.jsonl.gz` (one record per request).

## Details that matter for the numbers

| Topic | Behaviour |
|---|---|
| TTFT | Request sent → first chunk with non-empty `content`, `reasoning_content` or `text`. A role-only first chunk does not count. |
| Inter-token latency | Every gap between token-bearing chunks is recorded. |
| Token counts | From the server's `usage` (`stream_options.include_usage`); chunk count only as fallback. |
| Warm-up | Requests *started* before the warm-up ends are flagged and excluded. Closed loop: `warmupSeconds` or `warmupRequests` completions, whichever first. Open loop: arrivals in the first `warmupSeconds`. |
| Point end | ≥ `minRequests` measured and (`maxRequests` reached or `maxSeconds` since warm-up); in-flight requests finish. |
| Prompts | Random common English words, unique per request from the first word (no accidental prefix-cache hits). Length via a tokens-per-word ratio measured once with `POST /tokenize` (vLLM and llama.cpp both offer it); falls back to 1.3 if unavailable. |
| Shared prefix | `sharedPrefixTokens` in a scenario puts an identical prefix in front of every prompt (prefix-caching experiments). |
| Errors | Never thrown: HTTP errors, in-band stream errors, timeouts and network failures become records with `error` set (e.g. `overloaded`, `http_503`, `client_timeout`, `network:ECONNREFUSED`). |
| Client saturation | `performance.eventLoopUtilization()` over the point; above `client.maxEventLoopUtilization` (0.8) the point is flagged invalid. |
| Reproducibility | Every point and request derives its seed from the plan seed, label, scenario and point. |

## Tests

`pnpm --filter loadgen test` — statistics, prompt construction, the client against the simulated
mock, closed/open loop semantics, overflow handling, and a full matrix with an early ladder stop.
