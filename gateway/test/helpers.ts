import { createMockUpstream, type MockUpstream } from "mock-upstream";
import { buildApp, type GatewayApp } from "../src/app.ts";
import { type Config, parseConfig } from "../src/config.ts";

export interface Harness {
  mock: MockUpstream;
  gw: GatewayApp;
  url: string;
  config: Config;
  close(): Promise<void>;
}

/** Fast defaults so failure scenarios finish in milliseconds. */
export async function startHarness(
  overrides: Partial<Config> = {},
  mock?: MockUpstream,
): Promise<Harness> {
  const upstream = mock ?? (await createMockUpstream());
  const config = parseConfig({
    upstreamUrl: upstream.url,
    logLevel: "silent",
    ttftTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    totalTimeoutMs: 5_000,
    retryBaseMs: 5,
    retryMaxMs: 20,
    metricsPollMs: 0,
    forwardHeaders: "x-mock-*",
    ...overrides,
  });
  const gw = await buildApp(config, { pollUpstream: false });
  const url = await gw.app.listen({ port: 0, host: "127.0.0.1" });
  return {
    mock: upstream,
    gw,
    url,
    config,
    close: async () => {
      await gw.app.close();
      if (!mock) await upstream.close();
    },
  };
}

export const chatBody = (extra: object = {}) => ({
  model: "mock-model",
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});

export function postChat(
  url: string,
  body: object,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

export interface SseResult {
  events: string[];
  data: unknown[];
  done: boolean;
  text: string;
}

export async function readSse(res: Response): Promise<SseResult> {
  const text = await res.text();
  const events = text.split("\n\n").filter((e) => e.trim());
  const data: unknown[] = [];
  let done = false;
  for (const e of events) {
    const payload = e.replace(/^data: ?/, "");
    if (payload === "[DONE]") done = true;
    else data.push(JSON.parse(payload));
  }
  return { events, data, done, text };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until fn() is truthy or the timeout expires. */
export async function waitFor(fn: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await sleep(10);
  }
}

export async function metricValue(
  url: string,
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const text = await (await fetch(`${url}/metrics`)).text();
  let sum = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith(name)) continue;
    const m = line.match(/^([^\s{]+)(\{[^}]*\})?\s+(\S+)$/);
    if (!m || m[1] !== name) continue;
    const lbl = m[2] ?? "";
    if (Object.entries(labels).every(([k, v]) => lbl.includes(`${k}="${v}"`))) sum += Number(m[3]);
  }
  return sum;
}
