import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Agent, EnvHttpProxyAgent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestRecord } from "../src/client.ts";
import { sendStreaming } from "../src/client.ts";
import { authHeaders, makeDispatcher, runMatrix } from "../src/matrix.ts";
import { PlanSchema } from "../src/plan.ts";

/**
 * A fake OpenRouter: bearer auth, the /api/v1 path, SSE comment keep-alives, `provider` on
 * chunks, `usage.cost`, and reasoning deltas when the request does not turn reasoning off.
 */
interface Seen {
  auth: string | undefined;
  body: Record<string, unknown>;
}
function fakeRouter(seen: Seen[]): Server {
  return createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    seen.push({ auth: req.headers.authorization, body });
    if (req.url !== "/api/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== "Bearer sk-test") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 401, message: "no auth" } }));
      return;
    }
    if (body.model === "busy") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 429, message: "rate limited" } }));
      return;
    }
    const reasoningOff = (body.reasoning as { effort?: string } | undefined)?.effort === "none";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": OPENROUTER PROCESSING\n\n");
    const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const base = { id: "gen-123", provider: "FakeInfra", object: "chat.completion.chunk" };
    if (!reasoningOff) send({ ...base, choices: [{ delta: { reasoning: "hmm" } }] });
    for (const w of ["a", "b", "c", "d"]) send({ ...base, choices: [{ delta: { content: w } }] });
    send({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: 12,
        completion_tokens: reasoningOff ? 4 : 6,
        cost: 0.000042,
        completion_tokens_details: { reasoning_tokens: reasoningOff ? 0 : 2 },
        prompt_tokens_details: { cached_tokens: 0 },
      },
    });
    res.end("data: [DONE]\n\n");
  });
}

describe("hosted API target", () => {
  const seen: Seen[] = [];
  let server: Server;
  let base: string;
  const dispatcher = new Agent({ connections: null });
  beforeAll(async () => {
    server = fakeRouter(seen);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.close();
    await dispatcher.close();
  });

  const url = () => `${base}/api/v1/chat/completions`;
  const req = (extra: object = {}) => ({
    model: "qwen/qwen3.5-27b",
    messages: [{ role: "user", content: "x" }],
    max_tokens: 8,
    stream: true,
    ...extra,
  });

  it("sends the bearer key and reads provider, cost and reasoning", async () => {
    const out = await sendStreaming(url(), req(), {
      dispatcher,
      timeoutMs: 5000,
      headers: { authorization: "Bearer sk-test" },
      api: true,
    });
    expect(out.error).toBeNull();
    expect(out.completionTokens).toBe(6);
    expect(out.api).toEqual({
      id: "gen-123",
      provider: "FakeInfra",
      cost: 0.000042,
      reasoningTokens: 2,
      cachedTokens: 0,
      reasoningChunks: 1,
    });
  });

  it("shows when reasoning is really off", async () => {
    const out = await sendStreaming(url(), req({ reasoning: { effort: "none" } }), {
      dispatcher,
      timeoutMs: 5000,
      headers: { authorization: "Bearer sk-test" },
      api: true,
    });
    expect(out.api?.reasoningChunks).toBe(0);
    expect(out.api?.reasoningTokens).toBe(0);
    expect(out.tokenChunks).toBe(4);
  });

  it("keeps 429 apart from other errors and omits api fields for our own server", async () => {
    const limited = await sendStreaming(url(), req({ model: "busy" }), {
      dispatcher,
      timeoutMs: 5000,
      headers: { authorization: "Bearer sk-test" },
    });
    expect(limited.error).toBe("http_429");
    expect(limited.api).toBeUndefined();
    const unauth = await sendStreaming(url(), req(), { dispatcher, timeoutMs: 5000 });
    expect(unauth.error).toBe("http_401");
  });

  it("goes through an HTTP(S) proxy only when one is configured", async () => {
    const direct = makeDispatcher({});
    const proxied = makeDispatcher({ HTTPS_PROXY: "http://127.0.0.1:3128" });
    expect(direct).toBeInstanceOf(Agent);
    expect(proxied).toBeInstanceOf(EnvHttpProxyAgent);
    await Promise.all([direct.close(), proxied.close()]);
  });

  it("refuses to start without the key and never stores it", () => {
    const plan = PlanSchema.parse({
      name: "p",
      model: "m",
      target: "https://example.com",
      auth: { bearerEnv: "LG_TEST_KEY" },
      headers: { "X-Title": "lab" },
      scenarios: ["chat"],
      ladder: { concurrency: [1] },
    });
    expect(() => authHeaders(plan, {})).toThrow(/LG_TEST_KEY is not set/);
    expect(authHeaders(plan, { LG_TEST_KEY: "k" })).toEqual({
      "X-Title": "lab",
      authorization: "Bearer k",
    });
  });

  it("matrix: path, fixed calibration, no ignore_eos, prompt prefix, no key in results", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lg-api-"));
    const scenarioDir = join(dir, "scenarios");
    await mkdir(scenarioDir);
    await writeFile(
      join(scenarioDir, "tiny.yaml"),
      "name: tiny\ninputTokens: 10\noutputTokens: 8\nslo: { ttftP95Ms: 5000, tpotP95Ms: 5000, maxErrorRate: 0 }\n",
    );
    process.env.LG_TEST_KEY = "sk-test";
    const plan = PlanSchema.parse({
      name: "api",
      model: "qwen/qwen3.5-27b",
      target: base,
      chatPath: "/api/v1/chat/completions",
      auth: { bearerEnv: "LG_TEST_KEY" },
      hostedApi: true,
      tokensPerWord: 1,
      sendIgnoreEos: false,
      promptPrefix: "Write a long story using these words: ",
      scenarios: ["tiny"],
      scenarioDir,
      ladder: { concurrency: [1, 2] },
      point: { warmupSeconds: 0, warmupRequests: 0, maxRequests: 4, maxSeconds: 5, minRequests: 2 },
      extraBody: { reasoning: { effort: "none" }, provider: { order: ["fake"] } },
    });
    seen.length = 0;
    const out = join(dir, "run");
    await runMatrix({ plan, outDir: out, label: "api-test", log: () => {} });
    delete process.env.LG_TEST_KEY;

    const sent = seen.map((s) => s.body);
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(sent.every((b) => !("ignore_eos" in b))).toBe(true);
    expect(sent.every((b) => (b.provider as { order: string[] }).order[0] === "fake")).toBe(true);
    const first = sent[0] as { messages: { content: string }[] };
    const content = first.messages[0]?.content ?? "";
    expect(content.startsWith("Write a long story using these words: ")).toBe(true);
    expect(content.slice(39).split(" ")).toHaveLength(10);

    const run = JSON.parse(await readFile(join(out, "run.json"), "utf8"));
    expect(run.calibration.source).toBe("fixed");
    expect(run.hostedApi).toBe(true);
    const records = gunzipSync(
      await readFile(join(out, "points", "tiny", "c1", "requests.jsonl.gz")),
    )
      .toString()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as RequestRecord);
    expect(records.every((r) => r.api?.provider === "FakeInfra")).toBe(true);
    for (const f of ["run.json", "plan.yaml"]) {
      expect(await readFile(join(out, f), "utf8")).not.toContain("sk-test");
    }
  });
});
