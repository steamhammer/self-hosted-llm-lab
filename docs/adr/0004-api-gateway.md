# 0004. API gateway: custom TypeScript service (Fastify + undici)

- Status: Accepted
- Date: 2026-11-24

## Context

The lab needs a layer in front of vLLM that turns raw engine behaviour into a well-defined API:
streaming relay, separate TTFT / idle / total timeouts, retries that never duplicate tokens,
load shedding based on vLLM's queue, a single error vocabulary and Prometheus metrics. Its overhead
must be measurable (methodology §7), and every failure mode must be reproducible in tests without a GPU.

## Decision

A small TypeScript service on Node.js 26 LTS:

- [Fastify](https://fastify.dev) 5 for the HTTP server, [undici](https://github.com/nodejs/undici) for upstream
  calls (keep-alive pool, abortable streams), [zod](https://zod.dev) 4 for request/config validation,
  [@prometheus-io/client](https://github.com/prometheus/client_js) for metrics.
- A scriptable fake vLLM (`mock-upstream/`) drives deterministic tests of every failure mode.
- Bundled with [esbuild](https://esbuild.github.io) into one file, so it runs anywhere Node runs —
  including as a sidecar inside the vLLM image used on rented GPUs.

Key behaviours (details in [`gateway/README.md`](../../gateway/README.md)):
commit point at the first streamed event; retries only before it and never on timeouts;
client disconnect detected on the response and propagated as an upstream abort;
two-layer admission control that fails open.

## Alternatives considered

| Option | Why not here |
|---|---|
| [LiteLLM Proxy](https://github.com/BerriAI/litellm), [Envoy AI Gateway](https://github.com/envoyproxy/ai-gateway), [vLLM production-stack router](https://github.com/vllm-project/production-stack) | The right choice for production (routing, keys, budgets). Here the goal is to own and test the exact timeout/retry/abort semantics, which a ready-made gateway hides. |
| NestJS | DI and modules add structure a single-purpose proxy does not need; Fastify is what NestJS would run on anyway. |
| [Hono](https://hono.dev) (portable to Cloudflare Workers) | Attractive for an edge deployment later; for benchmarking the gateway must sit next to vLLM to keep network latency out of the numbers. |
| Python (FastAPI) | Closer to the ML ecosystem, but TypeScript is the author's primary stack; Node's streaming primitives are a good fit for SSE relaying. |

## Consequences

- Gateway overhead is measured directly (direct vs via gateway, same workload).
- Authentication, per-key quotas and multi-upstream routing are out of scope; documented as such.
- The single-file bundle must be checked after dependency upgrades (esbuild + Fastify/pino bundling).
