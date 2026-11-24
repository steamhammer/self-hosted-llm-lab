import { createMockUpstream } from "./index.ts";

const port = Number(process.env.PORT ?? 8000);
const host = process.env.HOST ?? "127.0.0.1";

const mock = await createMockUpstream({ port, host });
console.log(`mock-upstream listening on ${mock.url}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void mock.close().then(() => process.exit(0));
  });
}
