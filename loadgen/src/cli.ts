#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runMatrix } from "./matrix.ts";
import { loadPlan, type Plan } from "./plan.ts";

const USAGE = `Usage:
  loadgen matrix --plan <file> [--target <url>] [--model <id>] [--label <tag>] [--out <dir>]
                 [--scenarios a,b] [--metrics-url <url>] [--tokenize-url <url>]

Runs the plan: per scenario a closed-loop concurrency ladder (stops after consecutive SLO
violations), then open-loop Poisson rates. Writes raw per-request records for bench/analyze.
Default output: results/raw/<YYYY-MM-DD>_<label>_<HHMMSS>`;

function defaultOut(label: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return join("results", "raw", `${date}_${label}_${time}`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "matrix") {
    process.stderr.write(`${USAGE}\n`);
    return command === "--help" || command === "-h" ? 0 : 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      plan: { type: "string" },
      target: { type: "string" },
      model: { type: "string" },
      label: { type: "string" },
      out: { type: "string" },
      scenarios: { type: "string" },
      "metrics-url": { type: "string" },
      "tokenize-url": { type: "string" },
    },
  });
  if (!values.plan) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const overrides: Partial<Plan> = {};
  if (values.target) overrides.target = values.target;
  if (values.model) overrides.model = values.model;
  if (values.scenarios) overrides.scenarios = values.scenarios.split(",").map((s) => s.trim());
  if (values["metrics-url"]) overrides.metricsUrl = values["metrics-url"];
  if (values["tokenize-url"]) overrides.tokenizeUrl = values["tokenize-url"];

  const plan = await loadPlan(values.plan, overrides);
  const label = values.label ?? plan.name;
  const outDir = values.out ?? defaultOut(label);
  process.stderr.write(
    `loadgen: plan=${plan.name} target=${plan.target} model=${plan.model} out=${outDir}\n`,
  );
  const points = await runMatrix({ plan, outDir, label });
  const invalid = points.filter((p) => !p.clientValid).length;
  process.stderr.write(
    `done: ${points.length} points${invalid ? `, ${invalid} client-bound (invalid)` : ""} → ${outDir}\n`,
  );
  process.stdout.write(`${outDir}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`loadgen: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
