import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { Agent, type Dispatcher, EnvHttpProxyAgent, request } from "undici";
import { stringify } from "yaml";
import type { Plan, Scenario } from "./plan.ts";
import { loadScenario } from "./plan.ts";
import { type Calibration, calibrate, promptSource, seedOf } from "./prompts.ts";
import { type PointDeps, type PointRun, runClosedLoop, runOpenLoop } from "./runner.ts";
import { type QuickSummary, quickSummary } from "./stats.ts";

export const LOADGEN_VERSION = "0.1.0";

export interface MatrixOptions {
  plan: Plan;
  outDir: string;
  /** Free-form tag stored in run.json (e.g. "4090_qwen3.5-9b_bf16_direct"). */
  label: string;
  log?: (line: string) => void;
}

export interface PointSummary {
  scenario: string;
  pattern: PointRun["pattern"];
  value: number;
  dir: string;
  quick: QuickSummary;
  clientValid: boolean;
}

function fmt(v: number | null, digits = 0): string {
  return v === null ? "–" : v.toFixed(digits);
}

async function snapshot(url: string | undefined, file: string): Promise<void> {
  if (!url) return;
  try {
    const res = await request(url, { headersTimeout: 5_000, bodyTimeout: 5_000 });
    await writeFile(file, await res.body.text());
  } catch (err) {
    await writeFile(file, `# scrape failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function waitReady(url: string, timeoutMs: number, log: (s: string) => void): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request(url, { headersTimeout: 2_000, bodyTimeout: 2_000 });
      await res.body.dump();
      if (res.statusCode === 200) return;
    } catch {
      // not up yet
    }
    await sleep(1_000);
  }
  log(`  ! ${url} not ready after ${timeoutMs / 1000}s, continuing anyway`);
}

function requestBody(
  plan: Plan,
  scenario: Scenario,
  prompt: { prompt: string; maxTokens: number; ignoreEos: boolean },
) {
  return {
    model: plan.model,
    messages: [{ role: "user", content: plan.promptPrefix + prompt.prompt }],
    max_tokens: prompt.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    temperature: scenario.temperature,
    ...(scenario.topP !== undefined ? { top_p: scenario.topP } : {}),
    ...(prompt.ignoreEos && plan.sendIgnoreEos ? { ignore_eos: true } : {}),
    ...plan.extraBody,
  };
}

/** Builds request headers; fails before any request is sent when the API key is missing. */
export function authHeaders(
  plan: Plan,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const headers = { ...plan.headers };
  if (plan.auth) {
    const key = env[plan.auth.bearerEnv];
    if (!key) throw new Error(`${plan.auth.bearerEnv} is not set (plan.auth.bearerEnv)`);
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

/**
 * Connection pool for the run. Behind an HTTP(S) proxy (HTTPS_PROXY / HTTP_PROXY, e.g. a sandbox
 * that only reaches allow-listed hosts), requests go through it; NO_PROXY still sends localhost
 * (vLLM, the gateway, the mock) directly. undici ignores these variables unless asked.
 */
export function makeDispatcher(env: NodeJS.ProcessEnv = process.env): Dispatcher {
  const opts = { connections: null, keepAliveTimeout: 30_000 };
  const proxied = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].some((k) => env[k]);
  return proxied ? new EnvHttpProxyAgent(opts) : new Agent(opts);
}

/** Runs the whole plan: for each scenario a concurrency ladder, then open-loop rates. */
export async function runMatrix(opts: MatrixOptions): Promise<PointSummary[]> {
  const { plan, outDir, label } = opts;
  const log = opts.log ?? ((s: string) => process.stderr.write(`${s}\n`));
  const url = new URL(plan.chatPath, plan.target).toString();
  const headers = authHeaders(plan);
  const dispatcher = makeDispatcher();
  await mkdir(outDir, { recursive: true });

  const calibration: Calibration =
    plan.tokensPerWord !== undefined
      ? { tokensPerWord: plan.tokensPerWord, source: "fixed", sampleWords: 0 }
      : await calibrate(plan.tokenizeUrl ?? plan.target, plan.model);
  log(
    `calibration: ${calibration.tokensPerWord.toFixed(3)} tokens/word (${calibration.source}${calibration.error ? `: ${calibration.error}` : ""})`,
  );

  const startedAt = new Date().toISOString();
  await writeFile(join(outDir, "plan.yaml"), stringify(plan));
  const runMeta = {
    label,
    startedAt,
    loadgenVersion: LOADGEN_VERSION,
    target: plan.target,
    chatPath: plan.chatPath,
    model: plan.model,
    hostedApi: plan.hostedApi,
    extraBody: plan.extraBody,
    calibration,
  };
  await writeFile(join(outDir, "run.json"), `${JSON.stringify(runMeta, null, 2)}\n`);

  const summaries: PointSummary[] = [];
  try {
    for (const name of plan.scenarios) {
      const scenario = await loadScenario(plan.scenarioDir, name);
      await mkdir(join(outDir, "scenarios"), { recursive: true });
      await writeFile(join(outDir, "scenarios", `${name}.yaml`), stringify(scenario));

      if (plan.hooks.beforeScenario) {
        log(`[${name}] hook: ${plan.hooks.beforeScenario}`);
        execSync(plan.hooks.beforeScenario, {
          stdio: "inherit",
          env: { ...process.env, SCENARIO: name },
        });
        if (plan.readyUrl) await waitReady(plan.readyUrl, 15 * 60_000, log);
      }

      const runPoint = async (
        pattern: PointRun["pattern"],
        value: number,
      ): Promise<PointSummary> => {
        const pointSeed = seedOf(plan.seed, label, name, pattern, value);
        const prompts = await promptSource(scenario, calibration, pointSeed);
        const dir = join(
          outDir,
          "points",
          name,
          `${pattern === "concurrency" ? "c" : "r"}${value}`,
        );
        await mkdir(dir, { recursive: true });
        const deps: PointDeps = {
          url,
          dispatcher,
          config: plan.point,
          body: (i) => requestBody(plan, scenario, prompts(i)),
          maxInflight: plan.client.maxInflight,
          seed: pointSeed,
          headers,
          api: plan.hostedApi,
        };

        await snapshot(plan.metricsUrl, join(dir, "metrics-before.prom"));
        const startedAtPoint = new Date().toISOString();
        const run =
          pattern === "concurrency"
            ? await runClosedLoop(value, deps)
            : await runOpenLoop(value, deps);
        await snapshot(plan.metricsUrl, join(dir, "metrics-after.prom"));

        const quick = quickSummary(run.records, scenario.slo);
        const clientValid = run.client.eventLoopUtilization <= plan.client.maxEventLoopUtilization;
        const point = {
          scenario: name,
          pattern,
          value,
          seed: pointSeed,
          startedAt: startedAtPoint,
          wallMs: Math.round(run.wallMs),
          warmupEndMs: run.warmupEndMs === null ? null : Math.round(run.warmupEndMs),
          requests: {
            total: run.records.length,
            warmup: run.records.filter((r) => r.warmup).length,
            measured: quick.measured,
          },
          client: { ...run.client, valid: clientValid },
          slo: scenario.slo,
          quick,
        };
        await writeFile(join(dir, "point.json"), `${JSON.stringify(point, null, 2)}\n`);
        await writeFile(
          join(dir, "requests.jsonl.gz"),
          gzipSync(`${run.records.map((r) => JSON.stringify(r)).join("\n")}\n`),
        );

        log(
          `[${name}] ${pattern}=${value}: n=${quick.measured} err=${(quick.errorRate * 100).toFixed(1)}% ` +
            `ttft95=${fmt(quick.ttftP95)}ms tpot95=${fmt(quick.tpotP95, 1)}ms ` +
            `out=${quick.outputTokPerS.toFixed(0)} tok/s req=${quick.reqPerS.toFixed(2)}/s ` +
            `slo=${quick.sloOk ? "ok" : "VIOLATED"}${clientValid ? "" : ` CLIENT-BOUND(elu=${run.client.eventLoopUtilization})`}`,
        );
        if (plan.point.cooldownSeconds) await sleep(plan.point.cooldownSeconds * 1000);
        const summary = { scenario: name, pattern, value, dir, quick, clientValid };
        summaries.push(summary);
        return summary;
      };

      // 1. Closed-loop ladder with early stop.
      let violations = 0;
      let maxReqPerS = 0;
      for (const c of plan.ladder.concurrency) {
        const s = await runPoint("concurrency", c);
        maxReqPerS = Math.max(maxReqPerS, s.quick.reqPerS);
        violations = s.quick.sloOk ? 0 : violations + 1;
        if (violations >= plan.ladder.stopAfterViolations) {
          log(`[${name}] ${violations} consecutive SLO violations, stopping the ladder`);
          break;
        }
      }

      // 2. Open-loop Poisson arrivals at fractions of the best throughput seen.
      for (const f of plan.openLoop.fractions) {
        const rate = Math.round(maxReqPerS * f * 1000) / 1000;
        if (rate > 0) await runPoint("rate", rate);
      }
    }
  } finally {
    await dispatcher.close();
    const finishedAt = new Date().toISOString();
    await writeFile(
      join(outDir, "run.json"),
      `${JSON.stringify({ ...runMeta, finishedAt }, null, 2)}\n`,
    );
  }
  return summaries;
}
