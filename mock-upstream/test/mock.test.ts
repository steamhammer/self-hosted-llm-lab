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
