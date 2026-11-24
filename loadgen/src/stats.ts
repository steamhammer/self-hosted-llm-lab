import type { RequestRecord } from "./client.ts";
import type { Slo } from "./plan.ts";

/** Linear-interpolation percentile (same as numpy's default), p in [0, 100]. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (rank - lo);
}

/** (E2E − TTFT) / (output tokens − 1); output tokens from usage, else token chunks. */
export function tpot(r: RequestRecord): number | null {
  if (r.ttft === null || r.error) return null;
  const tokens = r.completionTokens ?? r.tokenChunks;
  return tokens > 1 ? (r.e2e - r.ttft) / (tokens - 1) : null;
}

export interface QuickSummary {
  measured: number;
  errors: number;
  errorRate: number;
  ttftP95: number | null;
  tpotP95: number | null;
  reqPerS: number;
  outputTokPerS: number;
  sloOk: boolean;
}

/**
 * Just enough statistics to decide whether the ladder keeps climbing. The authoritative numbers
 * are computed by bench/analyze from the raw records.
 */
export function quickSummary(records: RequestRecord[], slo: Slo): QuickSummary {
  const m = records.filter((r) => !r.warmup);
  const ok = m.filter((r) => !r.error);
  const errors = m.length - ok.length;
  const first = Math.min(...m.map((r) => r.start));
  const last = Math.max(...m.map((r) => r.start + r.e2e));
  const windowS = m.length ? Math.max((last - first) / 1000, 1e-9) : 1;
  const ttftP95 = percentile(
    ok.map((r) => r.ttft).filter((v): v is number => v !== null),
    95,
  );
  const tpotP95 = percentile(
    ok.map(tpot).filter((v): v is number => v !== null),
    95,
  );
  const errorRate = m.length ? errors / m.length : 1;
  const outTokens = ok.reduce((sum, r) => sum + (r.completionTokens ?? r.tokenChunks), 0);
  return {
    measured: m.length,
    errors,
    errorRate,
    ttftP95,
    tpotP95,
    reqPerS: ok.length / windowS,
    outputTokPerS: outTokens / windowS,
    sloOk:
      m.length > 0 &&
      errorRate <= slo.maxErrorRate &&
      ttftP95 !== null &&
      ttftP95 <= slo.ttftP95Ms &&
      (tpotP95 === null || tpotP95 <= slo.tpotP95Ms),
  };
}
