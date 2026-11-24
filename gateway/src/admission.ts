import { request } from "undici";
import type { Config } from "./config.ts";
import type { Metrics } from "./metrics.ts";

export type AdmissionResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: "inflight" | "upstream_queue" };

const WAITING_RE = /^vllm:num_requests_waiting(?:\{[^}]*\})?\s+([0-9.eE+-]+)\s*$/gm;

/** Sums all vllm:num_requests_waiting samples (one per model) in a Prometheus text payload. */
export function parseWaiting(metricsText: string): number | null {
  let total = 0;
  let found = false;
  for (const m of metricsText.matchAll(WAITING_RE)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) {
      total += v;
      found = true;
    }
  }
  return found ? total : null;
}

/**
 * Load shedding in two layers:
 *  1. a local cap on concurrently forwarded requests (bounds fan-out to the GPU);
 *  2. vLLM's own queue length, polled from its /metrics. A long queue means a new request would
 *     sit in vLLM and blow up TTFT for everyone — rejecting early with 429 + Retry-After is kinder.
 * If the metrics endpoint is unreachable, layer 2 fails open: we keep serving.
 */
export class Admission {
  private inflight = 0;
  private upstreamWaiting: number | null = null;
  private timer: NodeJS.Timeout | undefined;
  private readonly config: Config;
  private readonly metrics: Metrics;
  private readonly metricsUrl: string | null;

  constructor(config: Config, metrics: Metrics) {
    this.config = config;
    this.metrics = metrics;
    this.metricsUrl = config.upstreamMetricsPath
      ? new URL(config.upstreamMetricsPath, config.upstreamUrl).toString()
      : null;
    metrics.upstreamWaiting.set(-1);
  }

  tryAcquire(): AdmissionResult {
    if (this.inflight >= this.config.maxInflight) return { ok: false, reason: "inflight" };
    if (this.upstreamWaiting !== null && this.upstreamWaiting > this.config.maxUpstreamWaiting) {
      return { ok: false, reason: "upstream_queue" };
    }
    this.inflight++;
    this.metrics.inflight.set(this.inflight);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.inflight--;
        this.metrics.inflight.set(this.inflight);
      },
    };
  }

  get current(): number {
    return this.inflight;
  }

  /** Polls the upstream queue length once. */
  async refresh(): Promise<void> {
    if (!this.metricsUrl) return;
    const timeout = Math.max(this.config.metricsPollMs, 500);
    try {
      const res = await request(this.metricsUrl, { headersTimeout: timeout, bodyTimeout: timeout });
      const text = await res.body.text();
      this.upstreamWaiting = res.statusCode === 200 ? parseWaiting(text) : null;
    } catch {
      this.upstreamWaiting = null; // fail open
    }
    this.metrics.upstreamWaiting.set(this.upstreamWaiting ?? -1);
  }

  start(): void {
    if (!this.metricsUrl || this.config.metricsPollMs === 0 || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.config.metricsPollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
