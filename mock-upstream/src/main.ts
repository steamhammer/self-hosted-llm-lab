import { createMockUpstream, DEFAULT_SIM } from "./index.ts";

const env = process.env;
const port = Number(env.PORT ?? 8000);
const host = env.HOST ?? "127.0.0.1";
const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));

const sim =
  env.MOCK_SIM === "1"
    ? {
        slots: num(env.MOCK_SLOTS, DEFAULT_SIM.slots),
        itlMs: num(env.MOCK_ITL_MS, DEFAULT_SIM.itlMs),
        prefillUsPerToken: num(env.MOCK_PREFILL_US, DEFAULT_SIM.prefillUsPerToken),
        slowdownPerRunning: num(env.MOCK_SLOWDOWN, DEFAULT_SIM.slowdownPerRunning),
      }
    : false;

const mock = await createMockUpstream({ port, host, sim });
console.log(
  `mock-upstream listening on ${mock.url}${sim ? ` (simulation: ${JSON.stringify(sim)})` : ""}`,
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void mock.close().then(() => process.exit(0));
  });
}
