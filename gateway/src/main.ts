import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const { app } = await buildApp(config);

await app.listen({ host: config.host, port: config.port });
app.log.info({ upstream: config.upstreamUrl }, "gateway ready");

// Graceful shutdown: stop accepting, let in-flight streams finish, give up after the grace period.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    setTimeout(() => {
      app.log.warn("grace period exceeded, exiting");
      process.exit(1);
    }, config.shutdownGraceMs).unref();
    app.close().then(
      () => process.exit(0),
      (err) => {
        app.log.error({ err }, "error during shutdown");
        process.exit(1);
      },
    );
  });
}
