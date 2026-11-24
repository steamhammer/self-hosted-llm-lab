import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type Dispatcher, request } from "undici";
import { z } from "zod";
import type { Admission } from "./admission.ts";
import type { Config } from "./config.ts";
import {
  ClientAbortError,
  errorBody,
  fromUpstreamStatus,
  GatewayError,
  isNetworkError,
} from "./errors.ts";
import type { Metrics } from "./metrics.ts";
import { eventData, sseError, sseEvents } from "./sse.ts";

export interface ProxyDeps {
  config: Config;
  metrics: Metrics;
  admission: Admission;
  dispatcher: Dispatcher;
}

/** Only what the gateway itself relies on is validated; everything else passes through to vLLM. */
export const ChatRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(z.looseObject({ role: z.string().min(1) })).min(1),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stream_options: z.looseObject({ include_usage: z.boolean().optional() }).nullish(),
});

type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** What happened to one client request; logged and turned into metrics exactly once. */
interface Outcome {
  status: number;
  code: string;
  attempts: number;
  committed: boolean;
  clientAborted: boolean;
  ttftMs?: number;
  promptTokens?: number;
  completionTokens?: number;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

export function chatCompletionsHandler(deps: ProxyDeps) {
  const { config, metrics, admission } = deps;

  return async function handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const startedAt = performance.now();
    const outcome: Outcome = {
      status: 200,
      code: "",
      attempts: 0,
      committed: false,
      clientAborted: false,
    };
    let stream = false;
    let release: (() => void) | undefined;

    // Client disconnect detection. NB: listen on the *response*: `req.raw` emits "close" as soon as
    // the request body has been read, which in modern Node is not a disconnect signal.
    const requestCtl = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) requestCtl.abort(new ClientAbortError());
    };
    reply.raw.on("close", onClose);
    const deadline = setTimeout(
      () =>
        requestCtl.abort(
          new GatewayError(
            "upstream_timeout",
            `request exceeded the ${config.totalTimeoutMs} ms deadline`,
          ),
        ),
      config.totalTimeoutMs,
    );

    try {
      const body = validate(req.body, config);
      stream = body.stream === true;

      const admitted = admission.tryAcquire();
      if (!admitted.ok) {
        metrics.admissionRejections.inc({ reason: admitted.reason });
        throw new GatewayError(
          "overloaded",
          admitted.reason === "inflight"
            ? "Gateway concurrency limit reached, retry later"
            : "Model queue is full, retry later",
          { retryAfterS: config.retryAfterS },
        );
      }
      release = admitted.release;

      await forward(req, reply, body, stream, requestCtl.signal, outcome, deps, startedAt);
    } catch (err) {
      const reason = requestCtl.signal.aborted ? requestCtl.signal.reason : err;
      if (reason instanceof ClientAbortError) {
        // Nobody to answer: take the reply away from Fastify so it doesn't try to send one.
        if (!reply.sent) reply.hijack();
        if (!reply.raw.destroyed) reply.raw.destroy();
        outcome.clientAborted = true;
        outcome.code = "client_aborted";
        outcome.status = 499; // nginx convention, metrics/logs only
      } else {
        const gwErr = toGatewayError(reason);
        outcome.code = gwErr.code;
        if (outcome.committed) {
          // Headers are already sent: report in-band and close the stream.
          if (!reply.raw.destroyed) reply.raw.end(sseError(errorBody(gwErr, req.id)));
        } else {
          outcome.status = gwErr.status;
          if (gwErr.retryAfterS !== undefined)
            reply.header("retry-after", String(gwErr.retryAfterS));
          reply.code(gwErr.status).send(errorBody(gwErr, req.id));
        }
      }
    } finally {
      clearTimeout(deadline);
      reply.raw.off("close", onClose);
      release?.();
      record(req, outcome, stream, performance.now() - startedAt, deps);
    }
  };
}

function validate(raw: unknown, config: Config): ChatRequest {
  const parsed = ChatRequestSchema.safeParse(raw);
  if (!parsed.success) throw new GatewayError("invalid_request", z.prettifyError(parsed.error));
  const body = parsed.data;
  const requested = body.max_completion_tokens ?? body.max_tokens;
  if (requested !== undefined && requested > config.maxTokensCap) {
    throw new GatewayError(
      "invalid_request",
      `max_tokens must be <= ${config.maxTokensCap}, got ${requested}`,
    );
  }
  // Without a cap vLLM would generate up to the remaining context window.
  if (requested === undefined) body.max_tokens = config.maxTokensCap;
  return body;
}

async function forward(
  req: FastifyRequest,
  reply: FastifyReply,
  body: ChatRequest,
  stream: boolean,
  requestSignal: AbortSignal,
  outcome: Outcome,
  deps: ProxyDeps,
  startedAt: number,
): Promise<void> {
  const { config, metrics, dispatcher } = deps;
  const clientWantsUsage = body.stream_options?.include_usage === true;
  // Always ask vLLM for usage in streams (for metrics); strip that chunk if the client didn't ask.
  const upstreamBody = stream
    ? { ...body, stream_options: { ...body.stream_options, include_usage: true } }
    : body;
  const payload = JSON.stringify(upstreamBody);
  const url = new URL("/v1/chat/completions", config.upstreamUrl).toString();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    "x-request-id": req.id,
  };
  copyForwardedHeaders(req, config.forwardHeaders, headers);
  if (config.upstreamApiKey) headers.authorization = `Bearer ${config.upstreamApiKey}`;

  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      metrics.retries.inc();
      await sleep(backoffMs(attempt, config), undefined, { signal: requestSignal });
    }
    outcome.attempts = attempt + 1;

    const attemptCtl = new AbortController();
    const signal = AbortSignal.any([requestSignal, attemptCtl.signal]);
    // Streams: TTFT covers connect + queueing + prefill up to the first *token* (not just the first
    // chunk: engines may send a role-only chunk before prefill is done).
    // Non-streaming responses arrive only when generation is done, so only the deadline applies.
    const ttftTimer = stream
      ? setTimeout(
          () =>
            attemptCtl.abort(
              new GatewayError(
                "upstream_timeout",
                `no first token within ${config.ttftTimeoutMs} ms`,
              ),
            ),
          config.ttftTimeoutMs,
        )
      : undefined;
    let idleTimer: NodeJS.Timeout | undefined;

    try {
      const res = await request(url, {
        method: "POST",
        headers,
        body: payload,
        signal,
        dispatcher,
        headersTimeout: 0, // timeouts are ours, see above
        bodyTimeout: 0,
      });

      if (res.statusCode >= 400) {
        throw fromUpstreamStatus(res.statusCode, await res.body.text());
      }

      if (!stream) {
        const text = await res.body.text();
        recordUsage(text, outcome, metrics);
        metrics.upstreamAttempts.inc({ outcome: "ok" });
        outcome.status = res.statusCode;
        reply.code(res.statusCode).type("application/json").send(text);
        return;
      }

      // ---- streaming -------------------------------------------------------------------
      const events = sseEvents(res.body);
      const first = await events.next();
      if (first.done) {
        throw new GatewayError(
          "upstream_error",
          "upstream closed the stream before the first token",
          {
            retryable: true,
          },
        );
      }

      // Commit point: from here on the client has seen bytes, so there are no more retries.
      // The TTFT timer keeps running until the first token; if it fires now, the error goes in-band.
      metrics.upstreamAttempts.inc({ outcome: "ok" });
      reply.hijack();
      reply.raw.writeHead(200, { ...SSE_HEADERS, "x-request-id": req.id });
      outcome.committed = true;

      // The idle timer starts only after the first token: silence before it is prefill, which
      // the TTFT timeout governs.
      const onFirstToken = () => {
        clearTimeout(ttftTimer);
        outcome.ttftMs = performance.now() - startedAt;
        metrics.ttft.observe(outcome.ttftMs / 1000);
        idleTimer = setTimeout(
          () =>
            attemptCtl.abort(
              new GatewayError("upstream_timeout", `no tokens for ${config.idleTimeoutMs} ms`),
            ),
          config.idleTimeoutMs,
        );
      };

      if (await relayEvent(first.value, reply.raw, clientWantsUsage, outcome, metrics, signal))
        onFirstToken();
      for await (const event of events) {
        idleTimer?.refresh();
        const hasToken = await relayEvent(
          event,
          reply.raw,
          clientWantsUsage,
          outcome,
          metrics,
          signal,
        );
        if (hasToken && outcome.ttftMs === undefined) onFirstToken();
      }
      clearTimeout(ttftTimer); // stream may end without any token (e.g. max_tokens=0, error event)
      clearTimeout(idleTimer);
      reply.raw.end();
      return;
    } catch (err) {
      clearTimeout(ttftTimer);
      clearTimeout(idleTimer);
      // Classify first: aborting below would overwrite the signal's reason.
      const aborted = requestSignal.aborted;
      const gwErr = toGatewayError(signal.aborted ? signal.reason : err);
      attemptCtl.abort(); // make sure the upstream request is torn down (frees vLLM's KV cache)

      if (aborted) throw requestSignal.reason; // client gone or total deadline
      if (outcome.committed) throw midStream(gwErr, err);

      metrics.upstreamAttempts.inc({ outcome: gwErr.code });
      // Timeouts are not retried: a slow upstream gets slower when we add load to it.
      if (gwErr.retryable && attempt < config.maxRetries) continue;
      throw gwErr;
    }
  }
}

interface StreamChunk {
  usage?: Usage | null;
  choices?: { delta?: { content?: unknown; reasoning_content?: unknown }; text?: unknown }[];
  error?: unknown;
}

/** A chunk carries a generated token if any choice has non-empty content, reasoning or text. */
export function chunkHasToken(chunk: StreamChunk): boolean {
  const nonEmpty = (v: unknown) => typeof v === "string" && v.length > 0;
  return (chunk.choices ?? []).some(
    (c) => nonEmpty(c.delta?.content) || nonEmpty(c.delta?.reasoning_content) || nonEmpty(c.text),
  );
}

/**
 * Forwards one SSE event; returns true if it carried a generated token.
 * JSON is parsed only while looking for the first token and for usage/error chunks, so the
 * per-token overhead of the gateway stays a substring check.
 */
async function relayEvent(
  event: string,
  res: ServerResponse,
  clientWantsUsage: boolean,
  outcome: Outcome,
  metrics: Metrics,
  signal: AbortSignal,
): Promise<boolean> {
  let hasToken = false;
  const data = eventData(event);
  const lookForToken = outcome.ttftMs === undefined;
  if (
    data &&
    data !== "[DONE]" &&
    (lookForToken || data.includes('"usage"') || data.includes('"error"'))
  ) {
    try {
      const chunk = JSON.parse(data) as StreamChunk;
      hasToken = chunkHasToken(chunk);
      if (chunk.usage) {
        applyUsage(chunk.usage, outcome, metrics);
        if (!clientWantsUsage && Array.isArray(chunk.choices) && chunk.choices.length === 0)
          return false;
      }
      if (chunk.error) outcome.code = "upstream_error";
    } catch {
      // not JSON: forward untouched
    }
  }
  if (!res.write(`${event}\n\n`)) await once(res, "drain", { signal });
  return hasToken;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

function applyUsage(usage: Usage, outcome: Outcome, metrics: Metrics) {
  if (typeof usage.prompt_tokens === "number") {
    outcome.promptTokens = usage.prompt_tokens;
    metrics.tokens.inc({ kind: "prompt" }, usage.prompt_tokens);
  }
  if (typeof usage.completion_tokens === "number") {
    outcome.completionTokens = usage.completion_tokens;
    metrics.tokens.inc({ kind: "completion" }, usage.completion_tokens);
  }
}

function recordUsage(text: string, outcome: Outcome, metrics: Metrics) {
  try {
    const obj = JSON.parse(text) as { usage?: Usage };
    if (obj.usage) applyUsage(obj.usage, outcome, metrics);
  } catch {
    // ignore
  }
}

function copyForwardedHeaders(req: FastifyRequest, spec: string, into: Record<string, string>) {
  if (!spec) return;
  const rules = spec
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value !== "string" || name in into) continue;
    if (rules.some((r) => (r.endsWith("*") ? name.startsWith(r.slice(0, -1)) : name === r)))
      into[name] = value;
  }
}

/** Full-jitter exponential backoff. */
export function backoffMs(
  attempt: number,
  config: Pick<Config, "retryBaseMs" | "retryMaxMs">,
): number {
  const cap = Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * cap);
}

function midStream(gwErr: GatewayError, original: unknown): GatewayError {
  if (gwErr.code === "upstream_timeout") return gwErr;
  if (isNetworkError(original) || gwErr.code === "upstream_unavailable") {
    return new GatewayError("upstream_error", "upstream connection lost mid-stream", {
      cause: original,
    });
  }
  return gwErr;
}

export function toGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  if (isNetworkError(err)) {
    return new GatewayError("upstream_unavailable", "upstream is unreachable", {
      retryable: true,
      cause: err,
    });
  }
  return new GatewayError("internal_error", "internal gateway error", { cause: err });
}

function record(
  req: FastifyRequest,
  o: Outcome,
  stream: boolean,
  durationMs: number,
  deps: ProxyDeps,
) {
  const { metrics } = deps;
  const labels = { route: "chat_completions", stream: String(stream) };
  metrics.duration.observe(labels, durationMs / 1000);
  metrics.requests.inc({ ...labels, status: String(o.status), code: o.code });
  if (o.clientAborted) metrics.clientAborts.inc();

  const log = {
    status: o.status,
    code: o.code || undefined,
    stream,
    attempts: o.attempts,
    ttftMs: o.ttftMs === undefined ? undefined : Math.round(o.ttftMs),
    durationMs: Math.round(durationMs),
    promptTokens: o.promptTokens,
    completionTokens: o.completionTokens,
  };
  if (o.code && !o.clientAborted && o.status >= 500) req.log.warn(log, "request failed");
  else req.log.info(log, "request completed");
}
