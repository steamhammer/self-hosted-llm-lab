import { describe, expect, it } from "vitest";
import { parseWaiting } from "../src/admission.ts";
import { loadConfig } from "../src/config.ts";
import { fromUpstreamStatus, isNetworkError } from "../src/errors.ts";
import { backoffMs, chunkHasToken } from "../src/proxy.ts";
import { eventData, sseEvents } from "../src/sse.ts";

async function collect(chunks: string[]): Promise<string[]> {
  const enc = new TextEncoder();
  async function* gen() {
    for (const c of chunks) yield enc.encode(c);
  }
  const out: string[] = [];
  for await (const e of sseEvents(gen())) out.push(e);
  return out;
}

describe("sseEvents", () => {
  it("reassembles events split across chunks and handles CRLF", async () => {
    expect(await collect(["data: a", "bc\n", "\ndata: x\r\n\r\n", "data: [DONE]\n\n"])).toEqual([
      "data: abc",
      "data: x",
      "data: [DONE]",
    ]);
  });

  it("extracts multi-line data and ignores comments", () => {
    expect(eventData("data: a\ndata: b")).toBe("a\nb");
    expect(eventData(": keep-alive")).toBeNull();
  });
});

describe("parseWaiting", () => {
  it("sums samples across models", () => {
    const text =
      'vllm:num_requests_waiting{model_name="a"} 2.0\nvllm:num_requests_waiting{model_name="b"} 3.0\n';
    expect(parseWaiting(text)).toBe(5);
    expect(parseWaiting("other_metric 1")).toBeNull();
  });
});

describe("fromUpstreamStatus", () => {
  it("classifies upstream responses", () => {
    expect(
      fromUpstreamStatus(400, '{"message":"This model\'s maximum context length is 8192 tokens"}')
        .code,
    ).toBe("context_length_exceeded");
    expect(fromUpstreamStatus(400, '{"message":"bad temperature"}').code).toBe("invalid_request");
    expect(fromUpstreamStatus(404, "{}").code).toBe("model_not_found");
    expect(fromUpstreamStatus(503, "").retryable).toBe(true);
    expect(fromUpstreamStatus(500, "").retryable).toBe(false);
  });

  it("detects network errors through cause chains", () => {
    expect(isNetworkError(Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } }))).toBe(
      true,
    );
    expect(isNetworkError(new Error("x"))).toBe(false);
  });
});

describe("backoffMs", () => {
  it("stays within the exponential cap", () => {
    for (let i = 0; i < 100; i++) {
      expect(backoffMs(1, { retryBaseMs: 100, retryMaxMs: 1000 })).toBeLessThan(100);
      expect(backoffMs(5, { retryBaseMs: 100, retryMaxMs: 1000 })).toBeLessThan(1000);
    }
  });
});

describe("loadConfig", () => {
  it("reads env vars and rejects invalid ones", () => {
    const c = loadConfig({
      UPSTREAM_URL: "http://127.0.0.1:8000",
      MAX_RETRIES: "5",
      UPSTREAM_METRICS_PATH: "",
    });
    expect(c.maxRetries).toBe(5);
    expect(c.upstreamMetricsPath).toBe("");
    expect(() => loadConfig({ UPSTREAM_URL: "not a url" })).toThrow(
      /Invalid gateway configuration/,
    );
  });
});

describe("chunkHasToken", () => {
  it("counts content, reasoning and legacy text, but not role-only or empty chunks", () => {
    expect(chunkHasToken({ choices: [{ delta: { content: "Hi" } }] })).toBe(true);
    expect(chunkHasToken({ choices: [{ delta: { reasoning_content: "The" } }] })).toBe(true);
    expect(chunkHasToken({ choices: [{ text: "x" }] })).toBe(true);
    expect(chunkHasToken({ choices: [{ delta: { content: null } }] })).toBe(false);
    expect(chunkHasToken({ choices: [{ delta: { content: "" } }] })).toBe(false);
    expect(chunkHasToken({ choices: [] })).toBe(false);
  });
});
