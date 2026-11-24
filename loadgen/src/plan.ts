import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const int = z.number().int().nonnegative();

export const SloSchema = z.object({
  ttftP95Ms: z.number().positive(),
  tpotP95Ms: z.number().positive(),
  maxErrorRate: z.number().min(0).max(1),
});
export type Slo = z.infer<typeof SloSchema>;

/** One workload profile (methodology §3). Lives in bench/scenarios/<name>.yaml. */
export const ScenarioSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    /** synthetic: random prompts of a fixed length; dataset: prompts from a JSONL file. */
    kind: z.enum(["synthetic", "dataset"]).default("synthetic"),
    inputTokens: z.number().int().positive().optional(),
    /** Synthetic: exact output length (with ignoreEos). Dataset: upper bound per request. */
    outputTokens: z.number().int().positive(),
    /** Synthetic only: identical prefix shared by every request (prefix-caching experiments). */
    sharedPrefixTokens: int.default(0),
    /** Dataset only: JSONL with {"prompt": string, "max_tokens"?: number} per line. */
    dataset: z.string().optional(),
    ignoreEos: z.boolean().default(true),
    temperature: z.number().min(0).default(0),
    topP: z.number().gt(0).max(1).optional(),
    slo: SloSchema,
  })
  .refine((s) => s.kind === "dataset" || s.inputTokens !== undefined, {
    message: "synthetic scenarios need inputTokens",
  })
  .refine((s) => s.kind === "synthetic" || s.dataset !== undefined, {
    message: "dataset scenarios need a dataset path",
  });
export type Scenario = z.infer<typeof ScenarioSchema>;

export const PointConfigSchema = z.object({
  warmupSeconds: z.number().nonnegative().default(30),
  warmupRequests: int.default(20),
  maxRequests: z.number().int().positive().default(300),
  maxSeconds: z.number().positive().default(90),
  minRequests: int.default(30),
  cooldownSeconds: z.number().nonnegative().default(0),
  requestTimeoutSeconds: z.number().positive().default(600),
});
export type PointConfig = z.infer<typeof PointConfigSchema>;

/** A full measurement campaign against one server (methodology §4). Lives in bench/plans/. */
export const PlanSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  /** Base URL of the OpenAI-compatible API under test (vLLM directly, or the gateway). */
  target: z.url(),
  /** Base URL exposing POST /tokenize for prompt-length calibration; defaults to target. */
  tokenizeUrl: z.url().optional(),
  /** Server Prometheus endpoint, snapshotted before and after every point. */
  metricsUrl: z.url().optional(),
  /** Polled until it answers 200 after the beforeScenario hook (e.g. vLLM /health). */
  readyUrl: z.url().optional(),
  scenarios: z.array(z.string().min(1)).min(1),
  scenarioDir: z.string().default("bench/scenarios"),
  ladder: z.object({
    concurrency: z.array(z.number().int().positive()).min(1),
    /** Stop climbing after this many consecutive points that violate the SLO. */
    stopAfterViolations: z.number().int().positive().default(2),
  }),
  openLoop: z
    .object({
      /** Poisson arrival rates as fractions of the highest request rate seen in the ladder. */
      fractions: z.array(z.number().positive()).default([]),
    })
    .default({ fractions: [] }),
  point: PointConfigSchema.default(PointConfigSchema.parse({})),
  /** Merged into every request body, e.g. {chat_template_kwargs: {enable_thinking: false}}. */
  extraBody: z.record(z.string(), z.unknown()).default({}),
  hooks: z
    .object({
      /** Shell command run before each scenario, e.g. restarting the server to reset caches. */
      beforeScenario: z.string().optional(),
    })
    .default({}),
  client: z
    .object({
      /** Open loop: arrivals beyond this many in-flight requests are dropped and counted. */
      maxInflight: z.number().int().positive().default(4096),
      /** A point is flagged invalid when the client's event loop is busier than this. */
      maxEventLoopUtilization: z.number().gt(0).max(1).default(0.8),
    })
    .default({ maxInflight: 4096, maxEventLoopUtilization: 0.8 }),
  seed: int.default(1),
});
export type Plan = z.infer<typeof PlanSchema>;

function fail(file: string, error: z.ZodError): never {
  throw new Error(`${file}:\n${z.prettifyError(error)}`);
}

export async function loadPlan(file: string, overrides: Partial<Plan> = {}): Promise<Plan> {
  const raw = parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const parsed = PlanSchema.safeParse({ ...raw, ...overrides });
  if (!parsed.success) fail(file, parsed.error);
  return parsed.data;
}

export async function loadScenario(dir: string, name: string): Promise<Scenario> {
  const file = join(dir, `${name}.yaml`);
  const parsed = ScenarioSchema.safeParse(parse(await readFile(file, "utf8")));
  if (!parsed.success) fail(file, parsed.error);
  if (parsed.data.name !== name)
    throw new Error(`${file}: name "${parsed.data.name}" does not match file name`);
  return parsed.data;
}
