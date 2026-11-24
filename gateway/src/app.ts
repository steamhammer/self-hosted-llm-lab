import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance, LogController } from "fastify";
import { Agent, request } from "undici";
import { Admission } from "./admission.ts";
import type { Config } from "./config.ts";
import { errorBody, GatewayError } from "./errors.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { chatCompletionsHandler, toGatewayError } from "./proxy.ts";

export interface GatewayApp {
  app: FastifyInstance;
  metrics: Metrics;
  admission: Admission;
}

const REQUEST_ID_RE = /^[\w.:-]{1,128}$/;

export async function buildApp(
  config: Config,
  opts: { pollUpstream?: boolean } = {},
): Promise<GatewayApp> {
  const metrics = createMetrics();
  const admission = new Admission(config, metrics);
  // Keep-alive pool to the upstream. Retrying ECONNRESET before the first byte also covers the
  // classic race of reusing a keep-alive socket the server has just closed.
  const dispatcher = new Agent({ connect: { timeout: config.connectTimeoutMs } });

  const app = Fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel },
    // One summary line per request is logged by the handler instead of Fastify's two.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: config.bodyLimitBytes,
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    },
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-request-id", req.id);
    return payload;
  });

  // Errors raised before the route handler runs (bad JSON, body too large, unknown route...).
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const gwErr =
      err.statusCode !== undefined && err.statusCode < 500
        ? new GatewayError("invalid_request", err.message)
        : toGatewayError(err);
    if (gwErr.status >= 500) req.log.error({ err }, "unhandled error");
    metrics.requests.inc({
      route: req.routeOptions.url ?? "unknown",
      status: String(gwErr.status),
      code: gwErr.code,
      stream: "false",
    });
    reply.code(gwErr.status).send(errorBody(gwErr, req.id));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: {
        message: `Route ${req.method} ${req.url} not found`,
        type: "invalid_request_error",
        code: "not_found",
        request_id: req.id,
      },
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_req, reply) => {
    try {
      const res = await request(new URL(config.upstreamHealthPath, config.upstreamUrl), {
        dispatcher,
        headersTimeout: 2_000,
        bodyTimeout: 2_000,
      });
      await res.body.dump();
      if (res.statusCode < 400) return { status: "ready" };
    } catch {
      // fall through
    }
    return reply.code(503).send({ status: "upstream_unavailable" });
  });

  app.get("/metrics", async (_req, reply) => {
    reply.type(metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  app.get("/v1/models", async (req, reply) => {
    try {
      const res = await request(new URL("/v1/models", config.upstreamUrl), {
        dispatcher,
        headers: config.upstreamApiKey ? { authorization: `Bearer ${config.upstreamApiKey}` } : {},
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });
      return reply
        .code(res.statusCode)
        .type("application/json")
        .send(await res.body.text());
    } catch (err) {
      const gwErr = toGatewayError(err);
      return reply.code(gwErr.status).send(errorBody(gwErr, req.id));
    }
  });

  app.post(
    "/v1/chat/completions",
    chatCompletionsHandler({ config, metrics, admission, dispatcher }),
  );

  if (opts.pollUpstream ?? true) app.addHook("onReady", async () => admission.start());
  app.addHook("onClose", async () => {
    admission.stop();
    await dispatcher.close();
  });

  return { app, metrics, admission };
}
