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
}

export type Outcome = Omit<RequestRecord, "i" | "warmup" | "start">;

interface Chunk {
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  choices?: { delta?: { content?: unknown; reasoning_content?: unknown }; text?: unknown }[];
  error?: { code?: unknown; message?: unknown } | unknown;
}

const nonEmpty = (v: unknown) => typeof v === "string" && v.length > 0;

function hasToken(c: Chunk): boolean {
  return (c.choices ?? []).some(
    (ch) =>
      nonEmpty(ch.delta?.content) || nonEmpty(ch.delta?.reasoning_content) || nonEmpty(ch.text),
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
  opts: { dispatcher: Dispatcher; timeoutMs: number },
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
  let lastToken = 0;
  try {
    const res = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
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
