import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockUpstream, type MockUpstream } from "../src/index.ts";

let mock: MockUpstream;
beforeAll(async () => {
  mock = await createMockUpstream();
});
afterAll(() => mock.close());

const post = (body: object, headers: Record<string, string> = {}) =>
  fetch(`${mock.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("mock-upstream", () => {
  it("streams the requested number of tokens and usage", async () => {
    const res = await post(
      {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      },
      { "x-mock-tokens": "3", "x-mock-ttft-ms": "0", "x-mock-itl-ms": "0" },
    );
    const text = await res.text();
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(text.match(/tok\d/g)).toHaveLength(3);
    expect(text).toContain('"usage"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("fails the first N requests for a key, then succeeds", async () => {
    const h = { "x-mock-fail-times": "2", "x-mock-key": "k1", "x-mock-ttft-ms": "0" };
    const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
    expect((await post(body, h)).status).toBe(503);
    expect((await post(body, h)).status).toBe(503);
    expect((await post(body, h)).status).toBe(200);
  });

  it("exposes the waiting gauge in vLLM format", async () => {
    mock.setWaiting(7);
    const text = await (await fetch(`${mock.url}/metrics`)).text();
    expect(text).toMatch(/^vllm:num_requests_waiting\{[^}]*\} 7\.0$/m);
    mock.setWaiting(0);
  });
});

describe("mock-upstream simulation mode", () => {
  it("queues requests beyond the slot count and exposes the queue as waiting", async () => {
    const sim = await createMockUpstream({ sim: { slots: 1, itlMs: 20, prefillUsPerToken: 0 } });
    const body = { model: "m", messages: [{ role: "user", content: "a b c" }], max_tokens: 10 };
    const send = () =>
      fetch(`${sim.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const t0 = performance.now();
    const first = send();
    const second = send();
    await new Promise((r) => setTimeout(r, 50));
    const metrics = await (await fetch(`${sim.url}/metrics`)).text();
    expect(metrics).toMatch(/^vllm:num_requests_waiting\{[^}]*\} 1\.0$/m);
    await (await first).json();
    await (await second).json();
    // the second request waited for the first one's ~9 decode steps of 20 ms
    expect(performance.now() - t0).toBeGreaterThan(300);
    await sim.close();
  });

  it("counts prompt tokens as words, consistently with /tokenize", async () => {
    const res = await fetch(`${mock.url}/tokenize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "one two  three\nfour" }),
    });
    expect(((await res.json()) as { count: number }).count).toBe(4);
    const chat = await post(
      { model: "m", messages: [{ role: "user", content: "one two three four" }], max_tokens: 1 },
      { "x-mock-ttft-ms": "0" },
    );
    expect(((await chat.json()) as { usage: { prompt_tokens: number } }).usage.prompt_tokens).toBe(
      4,
    );
  });
});
