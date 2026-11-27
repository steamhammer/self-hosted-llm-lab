import { type Dispatcher, request } from "undici";

/** One request as the client saw it. Times in ms; `start` is relative to the point start. */
export interface RequestRecord {
  i: number;
  warmup: boolean;
  start: number;
  /** Request sent → first chunk with a generated token (content, reasoning or text). */
  ttft: number | null;
  e2e: number;
  /** Gaps between consecutive token-bearing chunks. */
  itl: number[];
  promptTokens: number | null;
  completionTokens: number | null;
  tokenChunks: number;
  status: number;
  error: string | null;
  /** Hosted APIs only (null on our own server): what the response said about itself. */
  api?: ApiInfo;
}

/**
 * Fields a hosted API reports per response. Kept apart from the timing fields so records from
 * vLLM and from an API share one schema. `reasoningChunks` > 0 or `reasoningTokens` > 0 means the
 * provider ignored "reasoning off" (methodology §3.4), which changes both cost and latency.
 */
export interface ApiInfo {
  /** Generation id, for looking the request up later in the provider's dashboard or API. */
  id: string | null;
  /** Which upstream served it, when the router says so (OpenRouter's `provider`). */
  provider: string | null;
  /** Billed cost in USD from `usage.cost`, as the router computed it. */
  cost: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  reasoningChunks: number;
}

export type Outcome = Omit<RequestRecord, "i" | "warmup" | "start">;

interface Chunk {
  id?: unknown;
  provider?: unknown;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    completion_tokens_details?: { reasoning_tokens?: number } | null;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  } | null;
  choices?: {
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
      reasoning_details?: unknown;
    };
    text?: unknown;
  }[];
  error?: { code?: unknown; message?: unknown } | unknown;
}

const nonEmpty = (v: unknown) => typeof v === "string" && v.length > 0;

/**
 * Readable reasoning only. Gemini sends a `reasoning.encrypted` detail (its thought signature)
 * even with thinking off; that is not reasoning text, so it counts neither as reasoning nor as a
 * token. Its `usage.completion_tokens_details.reasoning_tokens` stays 0.
 */
function readableDetail(d: unknown): boolean {
  const o = d as { type?: unknown; text?: unknown; summary?: unknown };
  return o?.type !== "reasoning.encrypted" && (nonEmpty(o?.text) || nonEmpty(o?.summary));
}

function hasReasoning(c: Chunk): boolean {
  return (c.choices ?? []).some((ch) => {
    const details = ch.delta?.reasoning_details;
    return (
      nonEmpty(ch.delta?.reasoning_content) ||
      nonEmpty(ch.delta?.reasoning) ||
      (Array.isArray(details) && details.some(readableDetail))
    );
  });
}

function hasToken(c: Chunk): boolean {
  return (
    hasReasoning(c) ||
    (c.choices ?? []).some((ch) => nonEmpty(ch.delta?.content) || nonEmpty(ch.text))
  );
}

/** OpenAI-style `error.code` when present (e.g. the gateway's "overloaded"), else the fallback. */
function errorCode(body: unknown, fallback: string): string {
  const e = (body as { error?: { code?: unknown } | string })?.error;
  if (e && typeof e === "object" && typeof e.code === "string") return e.code;
  if (e && typeof e === "object" && typeof e.code === "number") return `http_${e.code}`;
  return fallback;
}

/**
 * Sends one streaming chat completion and times it. Never throws: failures become
 * records with `error` set, so a point's error rate is measured, not lost.
 */
export async function sendStreaming(
  url: string,
  body: object,
  opts: {
    dispatcher: Dispatcher;
    timeoutMs: number;
    /** Extra request headers (auth for hosted APIs). Never written to results. */
    headers?: Record<string, string>;
    /** Collect the ApiInfo fields; on for hosted APIs. */
    api?: boolean;
  },
): Promise<Outcome> {
  const t0 = performance.now();
  const out: Outcome = {
    ttft: null,
    e2e: 0,
    itl: [],
    promptTokens: null,
    completionTokens: null,
    tokenChunks: 0,
    status: 0,
    error: null,
  };
  const api: ApiInfo | undefined = opts.api
    ? {
        id: null,
        provider: null,
        cost: null,
        reasoningTokens: null,
        cachedTokens: null,
        reasoningChunks: 0,
      }
    : undefined;
  if (api) out.api = api;
  let lastToken = 0;
  try {
    const res = await request(url, {
      method: "POST",
      headers: {
        ...opts.headers,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      dispatcher: opts.dispatcher,
      signal: AbortSignal.timeout(opts.timeoutMs),
      headersTimeout: 0,
      bodyTimeout: 0,
    });
    out.status = res.statusCode;
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      out.error = errorCode(parsed, `http_${res.statusCode}`);
      out.e2e = performance.now() - t0;
      return out;
    }

    const decoder = new TextDecoder();
    let buf = "";
    let sawDone = false;
    for await (const raw of res.body) {
      buf += decoder.decode(raw as Uint8Array, { stream: true });
      if (buf.includes("\r")) buf = buf.replace(/\r\n/g, "\n");
      for (let idx = buf.indexOf("\n\n"); idx !== -1; idx = buf.indexOf("\n\n")) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(line.startsWith("data: ") ? 6 : 5);
          if (data === "[DONE]") {
            sawDone = true;
            continue;
          }
          let chunk: Chunk;
          try {
            chunk = JSON.parse(data) as Chunk;
          } catch {
            continue;
          }
          if (chunk.error) out.error = errorCode(chunk, "stream_error");
          if (api) {
            if (api.id === null && typeof chunk.id === "string") api.id = chunk.id;
            if (api.provider === null && typeof chunk.provider === "string")
              api.provider = chunk.provider;
            if (hasReasoning(chunk)) api.reasoningChunks++;
            const u = chunk.usage;
            if (u) {
              if (typeof u.cost === "number") api.cost = u.cost;
              const r = u.completion_tokens_details?.reasoning_tokens;
              if (typeof r === "number") api.reasoningTokens = r;
              const c = u.prompt_tokens_details?.cached_tokens;
              if (typeof c === "number") api.cachedTokens = c;
            }
          }
          if (chunk.usage) {
            if (typeof chunk.usage.prompt_tokens === "number")
              out.promptTokens = chunk.usage.prompt_tokens;
            if (typeof chunk.usage.completion_tokens === "number")
              out.completionTokens = chunk.usage.completion_tokens;
          }
          if (hasToken(chunk)) {
            const now = performance.now();
            if (out.ttft === null) out.ttft = now - t0;
            else out.itl.push(Math.round((now - lastToken) * 100) / 100);
            lastToken = now;
            out.tokenChunks++;
          }
        }
      }
    }
    if (!sawDone && !out.error) out.error = "stream_incomplete";
  } catch (err) {
    const name = (err as { name?: string }).name;
    out.error =
      name === "TimeoutError"
        ? "client_timeout"
        : `network:${(err as { code?: string }).code ?? name}`;
  }
  out.e2e = performance.now() - t0;
  if (out.ttft !== null) out.ttft = Math.round(out.ttft * 100) / 100;
  out.e2e = Math.round(out.e2e * 100) / 100;
  return out;
}
