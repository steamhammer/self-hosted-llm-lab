/**
 * Fake vLLM: an OpenAI-compatible /v1/chat/completions server whose latency and failures
 * are scripted per request through `x-mock-*` headers. Used by the gateway tests and for
 * local development without a GPU.
 *
 * Request headers (all optional):
 *   x-mock-ttft-ms                delay before the first token            (default 20)
 *   x-mock-itl-ms                 delay between tokens                     (default 5)
 *   x-mock-tokens                 tokens to generate        (default: max_tokens or 16)
 *   x-mock-status                 respond with this HTTP error status instead
 *   x-mock-error                  "context_length" → vLLM's context-length 400 message
 *   x-mock-fail-times + x-mock-key  fail the first N requests that carry this key
 *                                 (status from x-mock-status, default 503), then succeed
 *   x-mock-drop-after-tokens      destroy the socket after N streamed tokens
 *   x-mock-stall-after-tokens     stop sending after N tokens, keep the connection open
 *   x-mock-hang                   never send response headers
 *   x-mock-role-first             send the role-only chunk right away, before the TTFT delay
 *                                 (some engines do this; it must not count as the first token)
 *
 * Simulation mode (opts.sim, or MOCK_SIM=1 for the standalone server): requests without
 * x-mock-ttft-ms / x-mock-itl-ms behave like a small GPU — a fixed number of slots with a FIFO
 * queue (exposed as vllm:num_requests_waiting), prefill time proportional to prompt length and
 * decode steps that slow down as more requests run. Good enough to exercise load tests locally.
 *
 * Tokens are whitespace-separated words: POST /tokenize counts them the same way usage does.
 *
 * Control endpoints:
 *   GET  /_mock/stats   counters + last request seen
 *   POST /_mock/state   { "waiting": n } → value of vllm:num_requests_waiting
 *   POST /_mock/reset   reset counters and state
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

export interface MockStats {
  requests: number;
  active: number;
  completed: number;
  aborted: number;
  lastBody: unknown;
  lastHeaders: Record<string, string | string[] | undefined>;
}

export interface SimOptions {
  /** Concurrent generations; further requests wait in a FIFO queue. */
  slots: number;
  /** Decode step time with a single running request. */
  itlMs: number;
  /** Prefill cost per prompt token, in microseconds. */
  prefillUsPerToken: number;
  /** Relative decode slowdown per additional running request (0.03 = +3% each). */
  slowdownPerRunning: number;
}

export const DEFAULT_SIM: SimOptions = {
  slots: 16,
  itlMs: 8,
  prefillUsPerToken: 100,
  slowdownPerRunning: 0.03,
};

export interface MockUpstream {
  app: FastifyInstance;
  url: string;
  stats: MockStats;
  setWaiting(n: number): void;
  reset(): void;
  close(): Promise<void>;
}

interface ChatBody {
  model?: string;
  messages?: unknown[];
  stream?: boolean;
  max_tokens?: number;
  stream_options?: { include_usage?: boolean };
}

const CONTEXT_LENGTH_MESSAGE =
  "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens " +
  "(39000 in the messages, 1000 in the completion). Please reduce the length of the messages or completion.";

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function intHeader(req: FastifyRequest, name: string): number | undefined {
  const v = header(req, name);
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function errorPayload(status: number, message: string) {
  // vLLM's error shape (OpenAI-compatible)
  return {
    object: "error",
    message,
    type: status >= 500 ? "InternalServerError" : "BadRequestError",
    param: null,
    code: status,
  };
}

function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function promptTokens(body: ChatBody): number {
  let n = 0;
  for (const m of body.messages ?? []) {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") n += countWords(content);
  }
  return Math.max(1, n);
}

/** FIFO semaphore modelling the engine's batch slots. */
class Slots {
  private running = 0;
  private readonly queue: (() => void)[] = [];
  private readonly size: number;
  constructor(size: number) {
    this.size = size;
  }
  get active(): number {
    return this.running;
  }
  get waiting(): number {
    return this.queue.length;
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.running < this.size) {
      this.running++;
    } else {
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const i = this.queue.indexOf(grant);
          if (i !== -1) this.queue.splice(i, 1);
          reject(signal.reason);
        };
        this.queue.push(grant);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next)
        next(); // hand the slot over directly
      else this.running--;
    };
  }
}

export async function createMockUpstream(
  opts: { port?: number; host?: string; sim?: Partial<SimOptions> | boolean } = {},
): Promise<MockUpstream> {
  const app = Fastify({ logger: false });
  const sim: SimOptions | null = opts.sim
    ? { ...DEFAULT_SIM, ...(typeof opts.sim === "object" ? opts.sim : {}) }
    : null;
  const slots = sim ? new Slots(sim.slots) : null;
  const stats: MockStats = {
    requests: 0,
    active: 0,
    completed: 0,
    aborted: 0,
    lastBody: null,
    lastHeaders: {},
  };
  const failCounters = new Map<string, number>();
  let waiting = 0;

  const reset = () => {
    Object.assign(stats, {
      requests: 0,
      active: 0,
      completed: 0,
      aborted: 0,
      lastBody: null,
      lastHeaders: {},
    });
    failCounters.clear();
    waiting = 0;
  };

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/v1/models", async () => ({
    object: "list",
    data: [{ id: "mock-model", object: "model", owned_by: "mock" }],
  }));

  app.get("/metrics", async (_req, reply) => {
    reply.type("text/plain; version=0.0.4");
    return [
      "# TYPE vllm:num_requests_running gauge",
      `vllm:num_requests_running{model_name="mock-model"} ${stats.active}.0`,
      "# TYPE vllm:num_requests_waiting gauge",
      `vllm:num_requests_waiting{model_name="mock-model"} ${waiting + (slots?.waiting ?? 0)}.0`,
      "",
    ].join("\n");
  });

  // vLLM: {"tokens":[...],"count":n}; llama.cpp: {"tokens":[...]}
  app.post("/tokenize", async (req) => {
    const body = (req.body ?? {}) as { prompt?: string; content?: string; messages?: unknown[] };
    const n =
      typeof body.prompt === "string" || typeof body.content === "string"
        ? countWords(body.prompt ?? body.content ?? "")
        : promptTokens({ messages: body.messages ?? [] });
    return { tokens: Array.from({ length: n }, (_, i) => i), count: n, max_model_len: 32768 };
  });

  app.get("/_mock/stats", async () => stats);
  app.post("/_mock/state", async (req) => {
    const body = (req.body ?? {}) as { waiting?: number };
    if (typeof body.waiting === "number") waiting = body.waiting;
    return { waiting };
  });
  app.post("/_mock/reset", async () => {
    reset();
    return { ok: true };
  });

  app.post("/v1/chat/completions", async (req, reply) => {
    const body = (req.body ?? {}) as ChatBody;
    stats.requests++;
    stats.lastBody = body;
    stats.lastHeaders = { ...req.headers };

    // --- scripted failures before any response ---------------------------------------
    if (header(req, "x-mock-hang") !== undefined) {
      reply.hijack();
      stats.active++;
      reply.raw.on("close", () => {
        stats.active--;
        stats.aborted++;
      });
      return; // never answer
    }

    const failTimes = intHeader(req, "x-mock-fail-times");
    const key = header(req, "x-mock-key") ?? "default";
    const status = intHeader(req, "x-mock-status");
    if (failTimes !== undefined) {
      const seen = failCounters.get(key) ?? 0;
      failCounters.set(key, seen + 1);
      if (seen < failTimes) {
        const s = status ?? 503;
        return reply.code(s).send(errorPayload(s, `mock failure ${seen + 1}/${failTimes}`));
      }
    } else if (status !== undefined) {
      const message =
        header(req, "x-mock-error") === "context_length"
          ? CONTEXT_LENGTH_MESSAGE
          : `mock error ${status}`;
      return reply.code(status).send(errorPayload(status, message));
    }

    // --- generation ----------------------------------------------------------------------
    const simulate =
      slots !== null &&
      sim !== null &&
      req.headers["x-mock-ttft-ms"] === undefined &&
      req.headers["x-mock-itl-ms"] === undefined;
    const ttft = intHeader(req, "x-mock-ttft-ms") ?? 20;
    const itl = intHeader(req, "x-mock-itl-ms") ?? 5;
    const nTokens = intHeader(req, "x-mock-tokens") ?? body.max_tokens ?? 16;
    const dropAfter = intHeader(req, "x-mock-drop-after-tokens");
    const stallAfter = intHeader(req, "x-mock-stall-after-tokens");
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = body.model ?? "mock-model";
    const usage = {
      prompt_tokens: promptTokens(body),
      completion_tokens: nTokens,
      total_tokens: promptTokens(body) + nTokens,
    };

    const ac = new AbortController();
    let finished = false;
    let releaseSlot: (() => void) | undefined;
    stats.active++;
    reply.raw.on("close", () => {
      stats.active--;
      releaseSlot?.();
      if (finished) stats.completed++;
      else {
        stats.aborted++;
        ac.abort();
      }
    });

    /** Time before the first token: queueing for a slot + prefill. */
    const waitFirstToken = async () => {
      if (!simulate) return sleep(ttft, undefined, { signal: ac.signal });
      releaseSlot = await (slots as Slots).acquire(ac.signal);
      await sleep((usage.prompt_tokens * (sim as SimOptions).prefillUsPerToken) / 1000, undefined, {
        signal: ac.signal,
      });
    };
    /** One decode step; slower when more requests share the batch. */
    const stepMs = () =>
      simulate
        ? (sim as SimOptions).itlMs *
          (1 + (sim as SimOptions).slowdownPerRunning * ((slots as Slots).active - 1))
        : itl;

    try {
      if (!body.stream) {
        await waitFirstToken();
        for (let i = 1; i < nTokens; i++) await sleep(stepMs(), undefined, { signal: ac.signal });
        releaseSlot?.();
        finished = true;
        const text = Array.from({ length: nTokens }, (_, i) => `tok${i}`).join(" ");
        return reply.send({
          id,
          object: "chat.completion",
          created,
          model,
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "length" },
          ],
          usage,
        });
      }

      // Streaming: headers go out immediately (like vLLM / Starlette), tokens follow.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

      const roleFirst = header(req, "x-mock-role-first") !== undefined;
      if (roleFirst) res.write(chunk({ role: "assistant", content: null }));
      await waitFirstToken();
      if (!roleFirst) res.write(chunk({ role: "assistant", content: "" }));
      for (let i = 0; i < nTokens; i++) {
        if (i > 0) await sleep(stepMs(), undefined, { signal: ac.signal });
        if (dropAfter !== undefined && i === dropAfter) {
          res.destroy();
          return;
        }
        if (stallAfter !== undefined && i === stallAfter) {
          await new Promise<void>((resolve) =>
            ac.signal.addEventListener("abort", () => resolve()),
          );
          return;
        }
        res.write(chunk({ content: `tok${i} ` }));
      }
      releaseSlot?.();
      res.write(chunk({}, "length"));
      if (body.stream_options?.include_usage) {
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`,
        );
      }
      res.write("data: [DONE]\n\n");
      finished = true;
      res.end();
    } catch (err) {
      if (!ac.signal.aborted) throw err; // client went away: nothing to answer
    }
  });

  const url = await app.listen({ port: opts.port ?? 0, host: opts.host ?? "127.0.0.1" });
  return {
    app,
    url,
    stats,
    setWaiting: (n) => {
      waiting = n;
    },
    reset,
    close: () => app.close(),
  };
}
