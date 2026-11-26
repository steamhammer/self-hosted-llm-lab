import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import type { Dispatcher } from "undici";
import { type RequestRecord, sendStreaming } from "./client.ts";
import type { PointConfig } from "./plan.ts";
import { rng } from "./prompts.ts";

export type Pattern = "concurrency" | "rate";

export interface PointRun {
  pattern: Pattern;
  value: number;
  records: RequestRecord[];
  wallMs: number;
  /** When the warm-up ended, relative to the point start (ms). */
  warmupEndMs: number | null;
  client: { eventLoopUtilization: number; cpuPercent: number; dropped: number };
}

export interface PointDeps {
  url: string;
  dispatcher: Dispatcher;
  config: PointConfig;
  /** Builds the request body for the i-th request of the point. */
  body: (i: number) => object;
  /** Open loop only: arrivals beyond this many in-flight requests are dropped. */
  maxInflight: number;
  seed: number;
  /** Request headers (hosted API auth). */
  headers?: Record<string, string>;
  /** Collect hosted-API fields on every record. */
  api?: boolean;
  onProgress?: (done: number) => void;
}

function measureClient<T>(fn: () => Promise<T>) {
  const elu0 = performance.eventLoopUtilization();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  return fn().then((result) => {
    const wallMs = performance.now() - t0;
    const elu = performance.eventLoopUtilization(elu0);
    const cpu = process.cpuUsage(cpu0);
    return {
      result,
      wallMs,
      eventLoopUtilization: Math.round(elu.utilization * 1000) / 1000,
      cpuPercent: Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 1000) / 10,
    };
  });
}

/**
 * Closed loop: `concurrency` workers, each sending its next request as soon as the previous one
 * finishes. Requests that *start* during the warm-up are flagged and excluded from statistics.
 * The warm-up ends after warmupSeconds or warmupRequests completions, whichever comes first.
 * The point ends once at least minRequests measured requests have completed and either
 * maxRequests are done or maxSeconds have passed since the warm-up; in-flight requests finish.
 */
export async function runClosedLoop(concurrency: number, deps: PointDeps): Promise<PointRun> {
  const { config } = deps;
  const t0 = performance.now();
  const records: RequestRecord[] = [];
  let issued = 0;
  let completed = 0;
  let measuredDone = 0;
  let warmupEnd: number | null =
    config.warmupSeconds === 0 || config.warmupRequests === 0 ? 0 : null;
  let stop = false;

  const worker = async () => {
    while (!stop) {
      const i = issued++;
      const start = performance.now() - t0;
      const warmup = warmupEnd === null;
      const outcome = await sendStreaming(deps.url, deps.body(i), {
        dispatcher: deps.dispatcher,
        timeoutMs: config.requestTimeoutSeconds * 1000,
        headers: deps.headers,
        api: deps.api,
      });
      records.push({ i, warmup, start: Math.round(start * 100) / 100, ...outcome });
      completed++;
      const now = performance.now() - t0;
      if (
        warmupEnd === null &&
        (now >= config.warmupSeconds * 1000 || completed >= config.warmupRequests)
      ) {
        warmupEnd = now;
      }
      if (!warmup) measuredDone++;
      deps.onProgress?.(measuredDone);
      if (
        warmupEnd !== null &&
        measuredDone >= config.minRequests &&
        (measuredDone >= config.maxRequests || now - warmupEnd >= config.maxSeconds * 1000)
      ) {
        stop = true;
      }
    }
  };

  const m = await measureClient(() => Promise.all(Array.from({ length: concurrency }, worker)));
  return {
    pattern: "concurrency",
    value: concurrency,
    records: records.sort((a, b) => a.i - b.i),
    wallMs: m.wallMs,
    warmupEndMs: warmupEnd,
    client: { eventLoopUtilization: m.eventLoopUtilization, cpuPercent: m.cpuPercent, dropped: 0 },
  };
}

/**
 * Open loop: Poisson arrivals at `rate` requests/s, independent of how fast the server answers —
 * this is what exposes queueing. Arrivals during the first warmupSeconds are flagged as warm-up.
 * Arrivals stop after maxRequests measured requests or maxSeconds after the warm-up.
 */
export async function runOpenLoop(rate: number, deps: PointDeps): Promise<PointRun> {
  const { config } = deps;
  const next = rng(deps.seed);
  const t0 = performance.now();
  const records: RequestRecord[] = [];
  const pending = new Set<Promise<void>>();
  const warmupMs = config.warmupSeconds * 1000;
  const endMs = warmupMs + config.maxSeconds * 1000;
  let dropped = 0;
  let measuredIssued = 0;
  let measuredDone = 0;
  let arrival = 0;

  const m = await measureClient(async () => {
    for (let i = 0; ; i++) {
      arrival += (-Math.log(1 - next()) / rate) * 1000;
      if (arrival >= endMs || measuredIssued >= config.maxRequests) break;
      const wait = arrival - (performance.now() - t0);
      if (wait > 0) await sleep(wait);
      const warmup = arrival < warmupMs;
      if (!warmup) measuredIssued++;
      if (pending.size >= deps.maxInflight) {
        dropped++;
        records.push({
          i,
          warmup,
          start: Math.round(arrival * 100) / 100,
          ttft: null,
          e2e: 0,
          itl: [],
          promptTokens: null,
          completionTokens: null,
          tokenChunks: 0,
          status: 0,
          error: "client_overflow",
        });
        continue;
      }
      const start = performance.now() - t0;
      const p = sendStreaming(deps.url, deps.body(i), {
        dispatcher: deps.dispatcher,
        timeoutMs: config.requestTimeoutSeconds * 1000,
        headers: deps.headers,
        api: deps.api,
      }).then((outcome) => {
        records.push({ i, warmup, start: Math.round(start * 100) / 100, ...outcome });
        if (!warmup) deps.onProgress?.(++measuredDone);
        pending.delete(p);
      });
      pending.add(p);
    }
    await Promise.all(pending);
  });

  return {
    pattern: "rate",
    value: rate,
    records: records.sort((a, b) => a.i - b.i),
    wallMs: m.wallMs,
    warmupEndMs: warmupMs,
    client: { eventLoopUtilization: m.eventLoopUtilization, cpuPercent: m.cpuPercent, dropped },
  };
}
