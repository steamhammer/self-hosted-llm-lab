import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "@prometheus-io/client";

export type Metrics = ReturnType<typeof createMetrics>;

/** One registry per app instance, so tests can run several gateways in one process. */
export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "gateway_process_" });

  return {
    registry,
    requests: new Counter({
      name: "gateway_requests_total",
      help: 'Completed requests by final HTTP status and error code (code="" on success)',
      labelNames: ["route", "status", "code", "stream"] as const,
      registers: [registry],
    }),
    duration: new Histogram({
      name: "gateway_request_duration_seconds",
      help: "End-to-end request duration as seen by the gateway",
      labelNames: ["route", "stream"] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 40, 80, 160, 300],
      registers: [registry],
    }),
    ttft: new Histogram({
      name: "gateway_ttft_seconds",
      help: "Time from request arrival to the first generated token (content or reasoning) relayed",
      buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32],
      registers: [registry],
    }),
    upstreamAttempts: new Counter({
      name: "gateway_upstream_attempts_total",
      help: "Upstream attempts by outcome",
      labelNames: ["outcome"] as const,
      registers: [registry],
    }),
    retries: new Counter({
      name: "gateway_retries_total",
      help: "Retries performed (attempts beyond the first)",
      registers: [registry],
    }),
    tokens: new Counter({
      name: "gateway_tokens_total",
      help: "Tokens reported by the upstream usage field",
      labelNames: ["kind"] as const,
      registers: [registry],
    }),
    inflight: new Gauge({
      name: "gateway_inflight_requests",
      help: "Requests currently being forwarded",
      registers: [registry],
    }),
    admissionRejections: new Counter({
      name: "gateway_admission_rejections_total",
      help: "Requests rejected with 429 by admission control",
      labelNames: ["reason"] as const,
      registers: [registry],
    }),
    clientAborts: new Counter({
      name: "gateway_client_aborts_total",
      help: "Requests abandoned by the client before completion",
      registers: [registry],
    }),
    upstreamWaiting: new Gauge({
      name: "gateway_upstream_waiting_requests",
      help: "Last observed vllm:num_requests_waiting (-1 when unknown)",
      registers: [registry],
    }),
  };
}
