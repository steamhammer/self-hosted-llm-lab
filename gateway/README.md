# Gateway

A small production-style API gateway in front of [vLLM](https://docs.vllm.ai)'s OpenAI-compatible server.
It exists to make the failure behaviour of LLM serving explicit and testable: streaming, timeouts,
retries, load shedding, clear errors and metrics. Stack: [Fastify](https://fastify.dev) 5,
[undici](https://github.com/nodejs/undici), [zod](https://zod.dev) 4,
[@prometheus-io/client](https://github.com/prometheus/client_js). Design rationale: [ADR-0004](../docs/adr/0004-api-gateway.md).

```
client ──HTTP/SSE──▶ gateway :8080 ──HTTP/SSE──▶ vLLM :8000
                       │  ▲                          │
                       │  └── polls /metrics ────────┘  (vllm:num_requests_waiting)
                       └── /metrics, /health, /ready
```

## Endpoints

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI-compatible; `stream: true` relays SSE |
| GET | `/v1/models` | proxied as is |
| GET | `/health` | liveness — the process is up |
| GET | `/ready` | readiness — the upstream answers its health path |
| GET | `/metrics` | Prometheus |

## Request lifecycle

1. **Validate** with zod — only the fields the gateway depends on (`model`, `messages`, `stream`,
   `max_tokens` / `max_completion_tokens`, `stream_options`); everything else passes through to vLLM.
   `max_tokens` above `MAX_TOKENS_CAP` → 400; missing → set to the cap (otherwise vLLM would generate
   up to the remaining context window).
2. **Admit** (see [Admission control](#admission-control)) or reject with 429 + `Retry-After`.
3. **Forward** with a per-request id (`x-request-id`, taken from the client if valid, otherwise generated).
4. For streams, wait for the **first SSE event** from upstream. Until then nothing has been sent to the client,
   so a failure here can still be retried or turned into a proper HTTP error.
5. **Commit**: send `200` + SSE headers and relay events one by one (whole events, never partial ones),
   with backpressure (`drain`) towards slow clients.
6. **First token**: the first chunk with non-empty `content`, `reasoning_content` or `text`. This is what
   TTFT measures. It is not the same as the first event: engines may send a role-only chunk
   (`{"role":"assistant","content":null}`) before prefill has finished. JSON is parsed only until this
   point and for usage/error chunks, so per-token overhead stays a substring check.
7. On finish, record one log line and metrics.

### Timeouts

| Timeout | Default | Covers | On expiry |
|---|---|---|---|
| `TTFT_TIMEOUT_MS` | 30 s | connect + vLLM queue + prefill, until the first token | 504 `upstream_timeout`, or in-band error if a role-only chunk was already relayed |
| `IDLE_TIMEOUT_MS` | 15 s | silence between two streamed events, **after** the first token | in-band SSE error, stream closed |
| `TOTAL_TIMEOUT_MS` | 300 s | the whole request, streaming included | 504, or in-band error after commit |
| `CONNECT_TIMEOUT_MS` | 2 s | TCP connect to upstream | retried as `upstream_unavailable` |

Non-streaming responses only arrive when generation is finished, so for them only the total deadline applies.
Every timeout **aborts the upstream request**, which makes vLLM stop generating and free the KV cache.

### Retries

- Only **before the first byte** reaches the client (the commit point). After that a retry would
  duplicate or reorder tokens.
- Only on connection errors (`ECONNREFUSED`, `ECONNRESET`, …) and upstream `429/502/503/504`.
  `ECONNRESET` on a reused keep-alive socket is the classic case this covers.
- **Not on timeouts**: a slow upstream gets slower when it receives more work (retry storm).
- **Not on 4xx**: the request itself is wrong.
- Full-jitter exponential backoff: `random(0, min(RETRY_MAX_MS, RETRY_BASE_MS · 2^(n-1)))`, at most `MAX_RETRIES` extra attempts.

### Client disconnects

Detected on the **response** (`reply.raw` `close` before `writableEnded`). The request's `close` event
fires as soon as its body has been read in modern Node, so it is not a disconnect signal. A disconnect
aborts the upstream request — the GPU stops working on an answer nobody will read.

### Errors after the commit point

The status is already `200`, so the gateway ends the stream with one OpenAI-style error event and no `[DONE]`:

```
data: {"error":{"message":"no tokens for 15000 ms","type":"server_error","code":"upstream_timeout","request_id":"…"}}
```

## Admission control

Two layers, both answering **429 `overloaded`** with `Retry-After: RETRY_AFTER_S`:

1. `MAX_INFLIGHT` — requests the gateway forwards at once.
2. `MAX_UPSTREAM_WAITING` — vLLM's own queue length (`vllm:num_requests_waiting`), polled every
   `METRICS_POLL_MS` from `UPSTREAM_METRICS_PATH`. A long queue means a new request would wait in vLLM
   and push TTFT past the SLO for everyone; rejecting early keeps latency bounded for admitted requests.

If the metrics endpoint is unreachable, layer 2 **fails open**.

## Errors

All errors use OpenAI's shape: `{"error": {"message", "type", "code", "request_id"}}`.

| `code` | HTTP | When |
|---|---|---|
| `invalid_request` | 400 | bad JSON, schema violation, `max_tokens` over the cap, other upstream 4xx |
| `context_length_exceeded` | 400 | upstream says the prompt + completion exceed the context window |
| `model_not_found` | 404 | upstream 404 |
| `overloaded` | 429 | admission control (with `Retry-After`) |
| `upstream_error` | 502 | upstream 5xx other than 503, connection lost mid-stream |
| `upstream_unavailable` | 503 | upstream unreachable or 429/503 after all retries |
| `upstream_timeout` | 504 | TTFT or total deadline exceeded |
| `internal_error` | 500 | bug in the gateway |

## Metrics

| Metric | Type | Labels |
|---|---|---|
| `gateway_requests_total` | counter | `route`, `status`, `code`, `stream` |
| `gateway_request_duration_seconds` | histogram | `route`, `stream` |
| `gateway_ttft_seconds` | histogram | — (request arrival → first generated token) |
| `gateway_upstream_attempts_total` | counter | `outcome` |
| `gateway_retries_total` | counter | — |
| `gateway_tokens_total` | counter | `kind` = prompt / completion |
| `gateway_inflight_requests` | gauge | — |
| `gateway_admission_rejections_total` | counter | `reason` = inflight / upstream_queue |
| `gateway_client_aborts_total` | counter | — |
| `gateway_upstream_waiting_requests` | gauge | — (−1 = unknown) |

Token counts come from vLLM's `usage`. For streams the gateway always sets
`stream_options.include_usage = true` upstream and drops the usage-only chunk if the client did not ask for it.

## Configuration

| Variable | Default | |
|---|---|---|
| `UPSTREAM_URL` | — (required) | e.g. `http://127.0.0.1:8000` |
| `UPSTREAM_HEALTH_PATH` | `/health` | used by `/ready` |
| `UPSTREAM_METRICS_PATH` | `/metrics` | empty disables queue-based admission |
| `UPSTREAM_API_KEY` | — | sent as `Authorization: Bearer` if vLLM uses `--api-key` |
| `FORWARD_HEADERS` | `traceparent,tracestate` | client headers copied upstream; `prefix*` allowed |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | |
| `LOG_LEVEL` | `info` | pino levels or `silent` |
| `CONNECT_TIMEOUT_MS`, `TTFT_TIMEOUT_MS`, `IDLE_TIMEOUT_MS`, `TOTAL_TIMEOUT_MS` | 2000 / 30000 / 15000 / 300000 | see [Timeouts](#timeouts) |
| `MAX_RETRIES`, `RETRY_BASE_MS`, `RETRY_MAX_MS` | 2 / 200 / 2000 | see [Retries](#retries) |
| `MAX_INFLIGHT`, `MAX_UPSTREAM_WAITING`, `METRICS_POLL_MS`, `RETRY_AFTER_S` | 256 / 32 / 1000 / 1 | see [Admission control](#admission-control) |
| `MAX_TOKENS_CAP` | 4096 | default and upper bound for `max_tokens` |
| `BODY_LIMIT_BYTES` | 4 MiB | |
| `SHUTDOWN_GRACE_MS` | 30000 | SIGTERM: stop accepting, let streams finish, then exit |

## Running locally

```bash
pnpm install

# against the mock upstream (two terminals)
pnpm dev:mock                                    # fake vLLM on :8000
UPSTREAM_URL=http://127.0.0.1:8000 FORWARD_HEADERS='x-mock-*' pnpm dev:gateway

curl -N localhost:8080/v1/chat/completions -H 'content-type: application/json' \
  -H 'x-mock-tokens: 20' -H 'x-mock-itl-ms: 50' \
  -d '{"model":"mock-model","messages":[{"role":"user","content":"hi"}],"stream":true}'

# against Ollama (no /health or /metrics there)
UPSTREAM_URL=http://127.0.0.1:11434 UPSTREAM_HEALTH_PATH=/ UPSTREAM_METRICS_PATH= pnpm dev:gateway
```

The mock's `x-mock-*` headers are documented at the top of [`mock-upstream/src/index.ts`](../mock-upstream/src/index.ts).

## Tests

`pnpm --filter gateway test` — every failure mode above has a test against the mock upstream:
TTFT / idle / total timeouts (including an early role-only chunk), retries and their limits, no retry after commit, upstream down,
context-length mapping, client disconnect before and after the first token, both admission layers,
fail-open, request-id propagation, metrics.

## Build

`pnpm --filter gateway bundle` → `dist/gateway.mjs`, a single file with all dependencies.
Docker: `docker buildx build --platform linux/amd64 -f gateway/Dockerfile .` (CI pushes it to GHCR).

## Not in scope (yet)

Client authentication and per-key rate limits, multiple upstreams / routing, request queueing with
priorities. For production these usually come from an existing gateway (see ADR-0004).
