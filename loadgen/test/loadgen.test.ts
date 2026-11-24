import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createMockUpstream, type MockUpstream } from "mock-upstream";
import { Agent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestRecord } from "../src/client.ts";
import { sendStreaming } from "../src/client.ts";
import { runMatrix } from "../src/matrix.ts";
import { PlanSchema, PointConfigSchema, ScenarioSchema } from "../src/plan.ts";
import { calibrate, promptSource, rng, seedOf } from "../src/prompts.ts";
import { runClosedLoop, runOpenLoop } from "../src/runner.ts";
import { percentile, quickSummary, tpot } from "../src/stats.ts";

const rec = (over: Partial<RequestRecord>): RequestRecord => ({
  i: 0,
  warmup: false,
  start: 0,
  ttft: 100,
  e2e: 1100,
  itl: [],
  promptTokens: 10,
  completionTokens: 11,
  tokenChunks: 11,
  status: 200,
  error: null,
  ...over,
});

describe("stats", () => {
  it("computes numpy-style percentiles", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10], 99)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });

  it("computes TPOT from usage and falls back to chunks", () => {
    expect(tpot(rec({}))).toBe(100); // (1100-100)/(11-1)
    expect(tpot(rec({ completionTokens: null, tokenChunks: 6 }))).toBe(200);
    expect(tpot(rec({ error: "x" }))).toBeNull();
  });

  it("excludes warm-up and judges the SLO", () => {
    const slo = { ttftP95Ms: 500, tpotP95Ms: 150, maxErrorRate: 0.1 };
    const ok = quickSummary(
      [rec({ warmup: true, ttft: 9999 }), rec({}), rec({ start: 1000 })],
      slo,
    );
    expect(ok.measured).toBe(2);
    expect(ok.sloOk).toBe(true);
    const slow = quickSummary([rec({ ttft: 900 }), rec({ ttft: 950 })], slo);
    expect(slow.sloOk).toBe(false);
    const failing = quickSummary([rec({}), rec({ error: "http_503", ttft: null })], slo);
    expect(failing.errorRate).toBe(0.5);
    expect(failing.sloOk).toBe(false);
  });
});

describe("prompts", () => {
  const scenario = ScenarioSchema.parse({
    name: "s",
    inputTokens: 100,
    outputTokens: 8,
    slo: { ttftP95Ms: 1, tpotP95Ms: 1, maxErrorRate: 0 },
  });
  const cal = { tokensPerWord: 1, source: "tokenize" as const, sampleWords: 1 };

  it("is deterministic per seed and unique per request", async () => {
    const a = await promptSource(scenario, cal, 42);
    const b = await promptSource(scenario, cal, 42);
    expect(a(3).prompt).toBe(b(3).prompt);
    expect(a(3).prompt).not.toBe(a(4).prompt);
    expect(a(0).prompt.split(" ")).toHaveLength(100);
    expect(a(0).maxTokens).toBe(8);
    expect(a(0).ignoreEos).toBe(true);
  });

  it("shares exactly the configured prefix", async () => {
    const shared = await promptSource({ ...scenario, sharedPrefixTokens: 60 }, cal, 1);
    const w0 = shared(0).prompt.split(" ");
    const w1 = shared(1).prompt.split(" ");
    expect(w0).toHaveLength(100);
    expect(w0.slice(0, 60)).toEqual(w1.slice(0, 60));
    expect(w0.slice(60)).not.toEqual(w1.slice(60));
  });

  it("reads dataset prompts and caps max_tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lg-"));
    const file = join(dir, "d.jsonl");
    await writeFile(
      file,
      '{"prompt":"hello there","max_tokens":5}\n{"prompt":"bye","max_tokens":500}\n',
    );
    const ds = ScenarioSchema.parse({
      ...scenario,
      kind: "dataset",
      dataset: file,
      outputTokens: 100,
    });
    const src = await promptSource(ds, cal, 7);
    const all = [src(0), src(1)];
    expect(all.map((p) => p.prompt).sort()).toEqual(["bye", "hello there"]);
    expect(all.find((p) => p.prompt === "bye")?.maxTokens).toBe(100);
    expect(all.every((p) => !p.ignoreEos)).toBe(true);
  });

  it("produces stable seeds and a uniform-ish rng", () => {
    expect(seedOf("a", 1)).toBe(seedOf("a", 1));
    expect(seedOf("a", 1)).not.toBe(seedOf("a", 2));
    const r = rng(1);
    const xs = Array.from({ length: 1000 }, r);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });
});

describe("against the simulated mock", () => {
  let mock: MockUpstream;
  const dispatcher = new Agent({ connections: null });
  beforeAll(async () => {
    mock = await createMockUpstream({
      sim: { slots: 4, itlMs: 1, prefillUsPerToken: 10, slowdownPerRunning: 0 },
    });
  });
  afterAll(async () => {
    await mock.close();
    await dispatcher.close();
  });

  const body = (max = 8) => ({
    model: "m",
    messages: [{ role: "user", content: "a b c d" }],
    max_tokens: max,
    stream: true,
    stream_options: { include_usage: true },
  });
  const url = () => `${mock.url}/v1/chat/completions`;

  it("times a streaming request and reads usage", async () => {
    const out = await sendStreaming(url(), body(5), { dispatcher, timeoutMs: 5000 });
    expect(out.error).toBeNull();
    expect(out.status).toBe(200);
    expect(out.ttft).toBeGreaterThan(0);
    expect(out.completionTokens).toBe(5);
    expect(out.promptTokens).toBe(4);
    expect(out.tokenChunks).toBe(5);
    expect(out.itl).toHaveLength(4);
  });

  it("records HTTP errors instead of throwing", async () => {
    const out = await sendStreaming(`${mock.url}/nope`, body(), { dispatcher, timeoutMs: 5000 });
    expect(out.status).toBe(404);
    expect(out.error).toMatch(/^http_404|not_found/);
    const down = await sendStreaming("http://127.0.0.1:1/v1/chat/completions", body(), {
      dispatcher,
      timeoutMs: 2000,
    });
    expect(down.error).toMatch(/^network:/);
  });

  it("calibrates against /tokenize and falls back when it is missing", async () => {
    expect((await calibrate(mock.url, "m")).tokensPerWord).toBe(1);
    const fallback = await calibrate("http://127.0.0.1:1", "m");
    expect(fallback.source).toBe("default");
  });

  it("closed loop: flags warm-up and stops at maxRequests", async () => {
    const config = PointConfigSchema.parse({
      warmupSeconds: 10,
      warmupRequests: 4,
      maxRequests: 12,
      minRequests: 1,
    });
    const run = await runClosedLoop(4, {
      url: url(),
      dispatcher,
      config,
      body: () => body(),
      maxInflight: 100,
      seed: 1,
    });
    const warm = run.records.filter((r) => r.warmup);
    const measured = run.records.filter((r) => !r.warmup);
    expect(warm.length).toBeGreaterThanOrEqual(4);
    expect(measured.length).toBeGreaterThanOrEqual(12);
    expect(measured.length).toBeLessThan(12 + 4); // at most one in-flight request per worker after stop
    expect(run.records.every((r) => r.error === null)).toBe(true);
    expect(run.client.eventLoopUtilization).toBeLessThan(1);
  });

  it("open loop: issues Poisson arrivals at roughly the requested rate", async () => {
    const config = PointConfigSchema.parse({ warmupSeconds: 0, maxRequests: 1000, maxSeconds: 1 });
    const run = await runOpenLoop(40, {
      url: url(),
      dispatcher,
      config,
      body: () => body(2),
      maxInflight: 100,
      seed: 3,
    });
    expect(run.records.length).toBeGreaterThan(20);
    expect(run.records.length).toBeLessThan(65);
    expect(run.records.every((r) => !r.warmup)).toBe(true);
  });

  it("open loop: drops arrivals beyond maxInflight and counts them", async () => {
    const config = PointConfigSchema.parse({ warmupSeconds: 0, maxRequests: 50, maxSeconds: 0.3 });
    const run = await runOpenLoop(200, {
      url: url(),
      dispatcher,
      config,
      body: () => body(200),
      maxInflight: 2,
      seed: 4,
    });
    expect(run.client.dropped).toBeGreaterThan(0);
    expect(run.records.filter((r) => r.error === "client_overflow")).toHaveLength(
      run.client.dropped,
    );
  });

  it("matrix: climbs the ladder, stops on SLO violations, writes raw data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lg-matrix-"));
    const scenarioDir = join(dir, "scenarios");
    await import("node:fs/promises").then((fs) => fs.mkdir(scenarioDir));
    // TTFT SLO so tight that queueing (4 slots) breaks it from concurrency 8 on
    await writeFile(
      join(scenarioDir, "tiny.yaml"),
      "name: tiny\ninputTokens: 20\noutputTokens: 20\nslo: { ttftP95Ms: 15, tpotP95Ms: 50, maxErrorRate: 0 }\n",
    );
    const plan = PlanSchema.parse({
      name: "t",
      model: "mock-model",
      target: mock.url,
      metricsUrl: `${mock.url}/metrics`,
      scenarios: ["tiny"],
      scenarioDir,
      ladder: { concurrency: [1, 2, 8, 16, 32, 64], stopAfterViolations: 2 },
      openLoop: { fractions: [0.5] },
      point: {
        warmupSeconds: 0,
        warmupRequests: 0,
        maxRequests: 16,
        maxSeconds: 5,
        minRequests: 4,
      },
    });
    const out = join(dir, "run");
    const lines: string[] = [];
    const points = await runMatrix({ plan, outDir: out, label: "test", log: (l) => lines.push(l) });

    const ladder = points.filter((p) => p.pattern === "concurrency").map((p) => p.value);
    expect(ladder).toEqual([1, 2, 8, 16]); // 8 and 16 violate → stop before 32
    expect(lines.some((l) => l.includes("stopping the ladder"))).toBe(true);
    expect(points.filter((p) => p.pattern === "rate")).toHaveLength(1);

    const point = JSON.parse(
      await readFile(join(out, "points", "tiny", "c2", "point.json"), "utf8"),
    );
    expect(point.requests.measured).toBeGreaterThanOrEqual(16);
    const records = gunzipSync(
      await readFile(join(out, "points", "tiny", "c2", "requests.jsonl.gz")),
    )
      .toString()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as RequestRecord);
    expect(records.length).toBe(point.requests.total);
    expect(
      await readFile(join(out, "points", "tiny", "c2", "metrics-before.prom"), "utf8"),
    ).toContain("vllm:num_requests_waiting");
    const run = JSON.parse(await readFile(join(out, "run.json"), "utf8"));
    expect(run.calibration.source).toBe("tokenize");
    expect(run.finishedAt).toBeTruthy();
  });
});
