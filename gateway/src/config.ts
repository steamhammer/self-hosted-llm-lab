import { z } from "zod";

const ms = (def: number) => z.coerce.number().int().nonnegative().default(def);
const int = (def: number) => z.coerce.number().int().nonnegative().default(def);

export const ConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().min(0).max(65535).default(8080),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** Base URL of the OpenAI-compatible upstream (vLLM), e.g. http://127.0.0.1:8000 */
  upstreamUrl: z.url(),
  upstreamHealthPath: z.string().default("/health"),
  /** Prometheus endpoint of the upstream; empty string disables queue-based admission. */
  upstreamMetricsPath: z.string().default("/metrics"),
  /**
   * Client headers copied to the upstream request: comma-separated names, `prefix*` allowed.
   * Default forwards W3C trace context; tests add "x-mock-*" to script the mock upstream.
   */
  forwardHeaders: z.string().default("traceparent,tracestate"),
  /** Sent as "Authorization: Bearer …" if vLLM runs with --api-key. */
  upstreamApiKey: z.string().optional(),

  connectTimeoutMs: ms(2_000),
  /** Request sent → first streamed chunk. Covers queueing + prefill. */
  ttftTimeoutMs: ms(30_000),
  /** Max silence between two streamed chunks once generation started. */
  idleTimeoutMs: ms(15_000),
  /** Hard deadline for the whole request, streaming included. */
  totalTimeoutMs: ms(300_000),

  /** Extra attempts after the first one; only before the first byte reaches the client. */
  maxRetries: int(2),
  retryBaseMs: ms(200),
  retryMaxMs: ms(2_000),

  /** Requests the gateway forwards concurrently; beyond that → 429. */
  maxInflight: int(256),
  /** Reject when vLLM's own queue (vllm:num_requests_waiting) is longer than this. */
  maxUpstreamWaiting: int(32),
  metricsPollMs: ms(1_000),
  retryAfterS: int(1),

  /** Default and upper bound for max_tokens. */
  maxTokensCap: int(4_096),
  bodyLimitBytes: int(4 * 1024 * 1024),
  shutdownGraceMs: ms(30_000),
});

export type Config = z.infer<typeof ConfigSchema>;

const ENV: Record<keyof Config, string> = {
  host: "HOST",
  port: "PORT",
  logLevel: "LOG_LEVEL",
  upstreamUrl: "UPSTREAM_URL",
  upstreamHealthPath: "UPSTREAM_HEALTH_PATH",
  upstreamMetricsPath: "UPSTREAM_METRICS_PATH",
  upstreamApiKey: "UPSTREAM_API_KEY",
  forwardHeaders: "FORWARD_HEADERS",
  connectTimeoutMs: "CONNECT_TIMEOUT_MS",
  ttftTimeoutMs: "TTFT_TIMEOUT_MS",
  idleTimeoutMs: "IDLE_TIMEOUT_MS",
  totalTimeoutMs: "TOTAL_TIMEOUT_MS",
  maxRetries: "MAX_RETRIES",
  retryBaseMs: "RETRY_BASE_MS",
  retryMaxMs: "RETRY_MAX_MS",
  maxInflight: "MAX_INFLIGHT",
  maxUpstreamWaiting: "MAX_UPSTREAM_WAITING",
  metricsPollMs: "METRICS_POLL_MS",
  retryAfterS: "RETRY_AFTER_S",
  maxTokensCap: "MAX_TOKENS_CAP",
  bodyLimitBytes: "BODY_LIMIT_BYTES",
  shutdownGraceMs: "SHUTDOWN_GRACE_MS",
};

/** Reads configuration from environment variables (see ENV for names). Throws on invalid values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw: Record<string, string> = {};
  for (const [key, name] of Object.entries(ENV)) {
    const v = env[name];
    if (v !== undefined && v !== "") raw[key] = v;
  }
  if (env.UPSTREAM_METRICS_PATH === "") raw.upstreamMetricsPath = "";
  return parseConfig(raw);
}

export function parseConfig(input: Record<string, unknown>): Config {
  const parsed = ConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid gateway configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
