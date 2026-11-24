import { afterEach, describe, expect, it } from "vitest";
import {
  chatBody,
  type Harness,
  metricValue,
  postChat,
  readSse,
  sleep,
  startHarness,
  waitFor,
} from "./helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const fast = { "x-mock-ttft-ms": "0", "x-mock-itl-ms": "0" };

describe("passthrough", () => {
  it("proxies a non-streaming completion", async () => {
    h = await startHarness();
    const res = await postChat(h.url, chatBody({ max_tokens: 4 }), fast);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage: { completion_tokens: number };
    };
    expect(body.choices[0]?.message.content).toBe("tok0 tok1 tok2 tok3");
    expect(body.usage.completion_tokens).toBe(4);
    expect(await metricValue(h.url, "gateway_tokens_total", { kind: "completion" })).toBe(4);
  });

  it("streams tokens and [DONE]", async () => {
    h = await startHarness();
    const res = await postChat(h.url, chatBody({ stream: true, max_tokens: 5 }), fast);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const sse = await readSse(res);
    expect(sse.text.match(/tok\d/g)).toHaveLength(5);
    expect(sse.done).toBe(true);
  });

  it("asks upstream for usage but hides the usage chunk unless the client asked", async () => {
    h = await startHarness();
    const hidden = await readSse(
      await postChat(h.url, chatBody({ stream: true, max_tokens: 2 }), fast),
    );
    expect(hidden.text).not.toContain('"usage":{');
    expect(
      (h.mock.stats.lastBody as { stream_options: { include_usage: boolean } }).stream_options
        .include_usage,
    ).toBe(true);
    expect(await metricValue(h.url, "gateway_tokens_total", { kind: "completion" })).toBe(2);

    const shown = await readSse(
      await postChat(
        h.url,
        chatBody({ stream: true, max_tokens: 2, stream_options: { include_usage: true } }),
        fast,
      ),
    );
    expect(shown.text).toContain('"usage":{');
  });

  it("propagates x-request-id to the client and the upstream", async () => {
    h = await startHarness();
    const res = await postChat(h.url, chatBody({ max_tokens: 1 }), {
      ...fast,
      "x-request-id": "req-123",
    });
    expect(res.headers.get("x-request-id")).toBe("req-123");
    expect(h.mock.stats.lastHeaders["x-request-id"]).toBe("req-123");
  });
});

describe("validation", () => {
  it("rejects a request without messages", async () => {
    h = await startHarness();
    const res = await postChat(h.url, { model: "m" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.request_id).toBeTruthy();
    expect(h.mock.stats.requests).toBe(0);
  });

  it("rejects malformed JSON in the same error format", async () => {
    h = await startHarness();
    const res = await fetch(`${h.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("rejects max_tokens above the cap and fills it in when missing", async () => {
    h = await startHarness({ maxTokensCap: 8 });
    expect((await postChat(h.url, chatBody({ max_tokens: 9 }))).status).toBe(400);
    const res = await postChat(h.url, chatBody(), fast);
    expect(res.status).toBe(200);
    expect((h.mock.stats.lastBody as { max_tokens: number }).max_tokens).toBe(8);
  });
});

describe("timeouts", () => {
  it("returns 504 when the first token does not arrive in time, and cancels upstream", async () => {
    h = await startHarness({ ttftTimeoutMs: 100 });
    const res = await postChat(h.url, chatBody({ stream: true }), { "x-mock-ttft-ms": "2000" });
    expect(res.status).toBe(504);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("upstream_timeout");
    await waitFor(() => h?.mock.stats.aborted === 1);
    expect(h.mock.stats.requests).toBe(1); // timeouts are not retried
  });

  it("returns 504 when upstream never sends headers", async () => {
    h = await startHarness({ ttftTimeoutMs: 100 });
    const res = await postChat(h.url, chatBody({ stream: true }), { "x-mock-hang": "1" });
    expect(res.status).toBe(504);
  });

  it("ends the stream with an in-band error when tokens stop flowing", async () => {
    h = await startHarness({ idleTimeoutMs: 100 });
    const res = await postChat(h.url, chatBody({ stream: true, max_tokens: 10 }), {
      ...fast,
      "x-mock-stall-after-tokens": "3",
    });
    expect(res.status).toBe(200); // already committed
    const sse = await readSse(res);
    expect(sse.text.match(/tok\d/g)).toHaveLength(3);
    const last = sse.data.at(-1) as { error: { code: string } };
    expect(last.error.code).toBe("upstream_timeout");
    expect(sse.done).toBe(false);
    await waitFor(() => h?.mock.stats.aborted === 1);
  });

  it("measures TTFT to the first token, not to a role-only chunk sent early", async () => {
    h = await startHarness();
    const res = await postChat(h.url, chatBody({ stream: true, max_tokens: 2 }), {
      "x-mock-role-first": "1",
      "x-mock-ttft-ms": "200",
      "x-mock-itl-ms": "0",
    });
    expect((await readSse(res)).done).toBe(true);
    expect(await metricValue(h.url, "gateway_ttft_seconds_count")).toBe(1);
    expect(await metricValue(h.url, "gateway_ttft_seconds_sum")).toBeGreaterThanOrEqual(0.2);
  });

  it("keeps the TTFT timeout running after an early role-only chunk", async () => {
    h = await startHarness({ ttftTimeoutMs: 100 });
    const res = await postChat(h.url, chatBody({ stream: true }), {
      "x-mock-role-first": "1",
      "x-mock-ttft-ms": "2000",
    });
    expect(res.status).toBe(200); // committed by the role chunk
    const sse = await readSse(res);
    const last = sse.data.at(-1) as { error: { code: string; message: string } };
    expect(last.error.code).toBe("upstream_timeout");
    expect(last.error.message).toMatch(/first token/);
    await waitFor(() => h?.mock.stats.aborted === 1);
    expect(await metricValue(h.url, "gateway_ttft_seconds_count")).toBe(0);
  });

  it("does not apply the idle timeout before the first token (prefill is TTFT's job)", async () => {
    h = await startHarness({ ttftTimeoutMs: 1_000, idleTimeoutMs: 100 });
    const res = await postChat(h.url, chatBody({ stream: true, max_tokens: 2 }), {
      "x-mock-role-first": "1",
      "x-mock-ttft-ms": "300",
      "x-mock-itl-ms": "0",
    });
    const sse = await readSse(res);
    expect(sse.done).toBe(true);
    expect(sse.text).not.toContain('"error"');
  });

  it("enforces the total deadline on long non-streaming requests", async () => {
    h = await startHarness({ totalTimeoutMs: 150 });
    const res = await postChat(h.url, chatBody({ max_tokens: 100 }), { "x-mock-itl-ms": "20" });
    expect(res.status).toBe(504);
    await waitFor(() => h?.mock.stats.aborted === 1);
  });
});

describe("retries", () => {
  it("retries 503 before the first byte and succeeds", async () => {
    h = await startHarness({ maxRetries: 2 });
    const res = await postChat(h.url, chatBody({ stream: true, max_tokens: 2 }), {
      ...fast,
      "x-mock-fail-times": "2",
      "x-mock-key": "r1",
    });
    expect(res.status).toBe(200);
    expect((await readSse(res)).done).toBe(true);
    expect(h.mock.stats.requests).toBe(3);
    expect(await metricValue(h.url, "gateway_retries_total")).toBe(2);
  });

  it("gives up after maxRetries with 503 upstream_unavailable", async () => {
    h = await startHarness({ maxRetries: 1 });
    const res = await postChat(h.url, chatBody(), { "x-mock-fail-times": "5", "x-mock-key": "r2" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "upstream_unavailable",
    );
    expect(h.mock.stats.requests).toBe(2);
  });

  it("does not retry client errors and maps context-length errors", async () => {
    h = await startHarness({ maxRetries: 3 });
    const res = await postChat(h.url, chatBody(), {
      "x-mock-status": "400",
      "x-mock-error": "context_length",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "context_length_exceeded",
    );
    expect(h.mock.stats.requests).toBe(1);
  });

  it("does not retry after the first byte: connection drop mid-stream becomes an in-band error", async () => {
    h = await startHarness({ maxRetries: 3 });
    const res = await postChat(h.url, chatBody({ stream: true, max_tokens: 10 }), {
      ...fast,
      "x-mock-drop-after-tokens": "4",
    });
    expect(res.status).toBe(200);
    const sse = await readSse(res);
    expect(sse.text.match(/tok\d/g)).toHaveLength(4);
    expect((sse.data.at(-1) as { error: { code: string } }).error.code).toBe("upstream_error");
    expect(h.mock.stats.requests).toBe(1);
  });

  it("returns 503 when the upstream is down", async () => {
    h = await startHarness({ maxRetries: 1 });
    await h.mock.close(); // nothing listens on the upstream port any more
    const res = await postChat(h.url, chatBody());
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "upstream_unavailable",
    );
    expect(
      await metricValue(h.url, "gateway_upstream_attempts_total", {
        outcome: "upstream_unavailable",
      }),
    ).toBe(2);
  });
});

describe("client disconnect", () => {
  it("cancels the upstream request when the client goes away mid-stream", async () => {
    h = await startHarness();
    const ac = new AbortController();
    const res = await postChat(
      h.url,
      chatBody({ stream: true, max_tokens: 1000 }),
      { "x-mock-itl-ms": "10" },
      ac.signal,
    );
    const reader = res.body?.getReader();
    await reader?.read(); // first chunk arrived
    ac.abort();
    await waitFor(() => h?.mock.stats.aborted === 1 && h.mock.stats.active === 0);
    await waitFor(() => h?.gw.admission.current === 0);
    expect(await metricValue(h.url, "gateway_client_aborts_total")).toBe(1);
  });

  it("cancels the upstream request when the client leaves before the first token", async () => {
    h = await startHarness();
    const ac = new AbortController();
    const pending = postChat(
      h.url,
      chatBody({ stream: true }),
      { "x-mock-ttft-ms": "5000" },
      ac.signal,
    ).catch(() => undefined);
    await waitFor(() => h?.mock.stats.active === 1);
    ac.abort();
    await pending;
    await waitFor(() => h?.mock.stats.aborted === 1);
  });
});

describe("admission control", () => {
  it("rejects with 429 + Retry-After when the gateway is at its concurrency limit", async () => {
    h = await startHarness({ maxInflight: 1, retryAfterS: 2 });
    const slow = postChat(h.url, chatBody({ max_tokens: 1 }), { "x-mock-ttft-ms": "300" });
    await waitFor(() => h?.gw.admission.current === 1);
    const res = await postChat(h.url, chatBody());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("overloaded");
    expect((await slow).status).toBe(200);
    expect(
      await metricValue(h.url, "gateway_admission_rejections_total", { reason: "inflight" }),
    ).toBe(1);
  });

  it("rejects when vLLM's own queue is too long, and recovers when it drains", async () => {
    h = await startHarness({ maxUpstreamWaiting: 4 });
    h.mock.setWaiting(10);
    await h.gw.admission.refresh();
    expect((await postChat(h.url, chatBody(), fast)).status).toBe(429);
    h.mock.setWaiting(0);
    await h.gw.admission.refresh();
    expect((await postChat(h.url, chatBody({ max_tokens: 1 }), fast)).status).toBe(200);
  });

  it("fails open when the upstream metrics endpoint is unavailable", async () => {
    h = await startHarness({ upstreamMetricsPath: "/does-not-exist", maxUpstreamWaiting: 0 });
    await h.gw.admission.refresh();
    expect((await postChat(h.url, chatBody({ max_tokens: 1 }), fast)).status).toBe(200);
  });
});

describe("operational endpoints", () => {
  it("reports readiness based on the upstream health", async () => {
    h = await startHarness();
    expect((await fetch(`${h.url}/ready`)).status).toBe(200);
    await h.mock.close();
    expect((await fetch(`${h.url}/ready`)).status).toBe(503);
    expect((await fetch(`${h.url}/health`)).status).toBe(200);
  });

  it("counts requests by status and code", async () => {
    h = await startHarness();
    await postChat(h.url, chatBody({ max_tokens: 1 }), fast);
    await postChat(h.url, { model: "m" });
    await sleep(10);
    expect(await metricValue(h.url, "gateway_requests_total", { status: "200", code: "" })).toBe(1);
    expect(
      await metricValue(h.url, "gateway_requests_total", {
        status: "400",
        code: "invalid_request",
      }),
    ).toBe(1);
  });
});
