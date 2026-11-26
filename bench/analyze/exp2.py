#!/usr/bin/env python3
"""Experiment 2 analysis: own GPU vs hosted API, and what quantization costs in quality.

  exp2.py breakeven [--runs results/raw/<run> ...] [--out results/exp2]
      U* per scenario: the share of time a rented GPU must run at capacity to match an API's
      price. Our side from <run>/analysis/capacity.csv, the API side from bench/api/providers.yaml.
  exp2.py api <api_run> ...  [--out results/exp2]
      Latency of hosted APIs per load point, 429s apart from other errors, whether reasoning was
      really off, and the cost the router billed against the price list.
  exp2.py quality <eval_dir> ... --ref <eval_dir> [--out results/exp2]
      Accuracy per task set with 95% bootstrap intervals, and every run paired against the
      reference (our BF16): paired difference with its interval, McNemar's exact test, and how
      often the answers are identical.

Methodology: docs/methodology.md §11, task sets and rules: docs/adr/0007.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
from analyze import load_run, request_tpot

PROVIDERS = ROOT / "bench" / "api" / "providers.yaml"
SCENARIOS = ROOT / "bench" / "scenarios"
BOOT = 10_000
SEED = 7

# ------------------------------------------------------------------------------------ helpers


def model_size(model: str) -> str:
    """'Qwen/Qwen3.5-27B-FP8' or 'qwen/qwen3.5-27b' → '27b'."""
    m = re.search(r"(\d+(?:\.\d+)?)b\b", model.lower())
    return f"{m.group(1)}b" if m else model.lower()


def md_table(df: pd.DataFrame) -> str:
    cols = list(df.columns)
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for _, row in df.iterrows():
        lines.append("| " + " | ".join("" if pd.isna(v) else str(v) for v in row) + " |")
    return "\n".join(lines)


def scenario_ratio(name: str) -> float:
    """Input tokens per output token of a synthetic scenario (chat 512/256 = 2)."""
    spec = yaml.safe_load((SCENARIOS / f"{name}.yaml").read_text())
    return spec["inputTokens"] / spec["outputTokens"]


# ---------------------------------------------------------------------------------- breakeven


def api_price_per_1m_output(ep: dict, ratio: float) -> float:
    """API price in our unit: $ per 1M output tokens including the prompt that came with them."""
    return ratio * ep["input"] + ep["output"]


def our_runs(paths: list[Path] | None) -> list[Path]:
    if paths:
        return paths
    found = []
    for cap in sorted((ROOT / "results" / "raw").glob("*/analysis/capacity.csv")):
        name = cap.parents[1].name
        if "_gateway_" in name or "_api_" in name or "_rehearsal" in name:
            continue
        found.append(cap.parents[1])
    return found


def breakeven(runs: list[Path], providers: Path = PROVIDERS) -> pd.DataFrame:
    data = yaml.safe_load(providers.read_text())
    endpoints = [e for e in data["endpoints"] if e.get("quantization") != "n/a"]
    rows = []
    for run in runs:
        meta = json.loads((run / "run.json").read_text())
        cap = pd.read_csv(run / "analysis" / "capacity.csv")
        cap = cap[cap["pattern"] == "concurrency"]
        size = model_size(meta["model"])
        for _, c in cap.iterrows():
            if pd.isna(c["usd_per_1m_output"]):
                continue
            ratio = scenario_ratio(c["scenario"])
            for ep in endpoints:
                if model_size(ep["model"]) != size:
                    continue
                api = api_price_per_1m_output(ep, ratio)
                ours = float(c["usd_per_1m_output"])
                rows.append(
                    {
                        "run": meta["label"],
                        "model": meta["model"],
                        "scenario": c["scenario"],
                        "ours_usd_per_1m": round(ours, 3),
                        "api": ep["id"],
                        "api_quantization": ep["quantization"],
                        "api_usd_per_1m": round(api, 3),
                        "u_star": round(ours / api, 3),
                        "pays_off": "never" if ours > api else f"above {ours / api:.0%} load",
                    }
                )
    df = pd.DataFrame(rows)
    if len(df):
        df.attrs["snapshot"] = str(data["snapshot"])
    return df


# --------------------------------------------------------------------------------------- api


def api_points(run_dir: Path) -> pd.DataFrame:
    run = load_run(run_dir)
    env = json.loads((run_dir / "env.json").read_text()) if (run_dir / "env.json").exists() else {}
    ep = env.get("endpoint", {})
    rows = []
    for p in run.points:
        r = p.records
        r = r[~r["warmup"]]
        ok = r[r["error"].isna()]
        api = pd.json_normalize(ok["api"].tolist()) if "api" in ok and len(ok) else pd.DataFrame()
        billed = api["cost"].dropna() if "cost" in api else pd.Series(dtype=float)
        cost = float(billed.sum()) if len(billed) else float("nan")
        out_tokens = ok["completionTokens"].fillna(ok["tokenChunks"]).sum()
        prompt_tokens = ok["promptTokens"].sum()
        ratio = prompt_tokens / out_tokens if out_tokens else float("nan")
        listed = (
            (prompt_tokens * ep["input"] + out_tokens * ep["output"]) / 1e6
            if ep and out_tokens
            else float("nan")
        )
        tp = ok.apply(request_tpot, axis=1) if len(ok) else pd.Series(dtype=float)
        rows.append(
            {
                "run": run.meta.get("label"),
                "endpoint": ep.get("id"),
                "daypart": env.get("daypart"),
                "scenario": p.scenario,
                "concurrency": int(p.value),
                "n": len(r),
                "errors": int(r["error"].notna().sum()),
                "http_429": int((r["error"] == "http_429").sum()),
                "ttft_p50": round(ok["ttft"].quantile(0.5), 1) if len(ok) else None,
                "ttft_p95": round(ok["ttft"].quantile(0.95), 1) if len(ok) else None,
                "tpot_p50": round(tp.quantile(0.5), 2) if len(tp) else None,
                "tpot_p95": round(tp.quantile(0.95), 2) if len(tp) else None,
                "output_tokens_mean": round(out_tokens / len(ok), 1) if len(ok) else None,
                "reasoning_leak": int(
                    (api.get("reasoningChunks", pd.Series(dtype=float)) > 0).sum()
                ),
                "providers_seen": ",".join(sorted(api["provider"].dropna().unique()))
                if "provider" in api
                else "",
                "billed_usd": round(cost, 6),
                "listed_usd": round(listed, 6),
                "billed_usd_per_1m_output": round(cost / out_tokens * 1e6, 3)
                if out_tokens
                else None,
                "input_per_output": round(ratio, 2),
            }
        )
    return pd.DataFrame(rows)


# ----------------------------------------------------------------------------------- quality

# Primary score per task: (filter, metric). GSM8K: last number in the answer, robust to the
# model's own phrasing; MMLU-Pro: the task's own answer regex; IFEval: prompt-level strict.
PRIMARY = {
    "gsm8k_cot_llama": ("flexible-extract", "exact_match"),
    "mmlu_pro": ("custom-extract", "exact_match"),
    "ifeval": ("none", "prompt_level_strict_acc"),
}
# H4 groups inside MMLU-Pro: subjects whose questions are mostly multi-step calculation vs
# subjects that are mostly recall and reading.
QUANTITATIVE = {"math", "physics", "chemistry", "engineering"}


def task_group(task: str) -> str:
    return "mmlu_pro" if task.startswith("mmlu_pro_") else task


def load_eval(eval_dir: Path) -> pd.DataFrame:
    rows = []
    for f in sorted((eval_dir / "samples").glob("*.jsonl.gz")):
        task = f.name.removesuffix(".jsonl.gz")
        group = task_group(task)
        if group not in PRIMARY:
            continue
        flt, metric = PRIMARY[group]
        with gzip.open(f, "rt") as fh:
            for line in fh:
                s = json.loads(line)
                if s.get("filter") != flt or metric not in s:
                    continue
                resp = s.get("resps") or [[""]]
                rows.append(
                    {
                        "task": task,
                        "group": group,
                        "subject": task.removeprefix("mmlu_pro_") if group == "mmlu_pro" else "",
                        "doc_id": s["doc_id"],
                        "prompt_hash": s.get("prompt_hash"),
                        "correct": float(bool(s[metric])),
                        "answer": str((s.get("filtered_resps") or [""])[0]),
                        "raw": str(resp[0][0] if resp and resp[0] else ""),
                    }
                )
    df = pd.DataFrame(rows)
    if not len(df):
        raise SystemExit(f"{eval_dir}: no scored samples")
    return df


def boot_ci(values: np.ndarray, rng: np.random.Generator) -> tuple[float, float]:
    if len(values) == 0:
        return (math.nan, math.nan)
    idx = rng.integers(0, len(values), size=(BOOT, len(values)))
    means = values[idx].mean(axis=1)
    return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def mcnemar_exact(b: int, c: int) -> float:
    """Two-sided exact McNemar p-value: binomial test on the discordant pairs."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2**n
    return min(1.0, 2 * tail)


def first_divergence(a: str, b: str) -> int | None:
    """Character index where two answers stop being identical; None if identical."""
    if a == b:
        return None
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            return i
    return n


def subsets(df: pd.DataFrame) -> dict[str, pd.DataFrame]:
    out = {g: d for g, d in df.groupby("group")}
    mp = df[df["group"] == "mmlu_pro"]
    if len(mp):
        out["mmlu_pro:quantitative"] = mp[mp["subject"].isin(QUANTITATIVE)]
        out["mmlu_pro:knowledge"] = mp[~mp["subject"].isin(QUANTITATIVE)]
    return out


def accuracy_table(runs: dict[str, pd.DataFrame]) -> pd.DataFrame:
    rng = np.random.default_rng(SEED)
    rows = []
    for name, df in runs.items():
        for subset, d in subsets(df).items():
            lo, hi = boot_ci(d["correct"].to_numpy(), rng)
            rows.append(
                {
                    "run": name,
                    "set": subset,
                    "n": len(d),
                    "accuracy": round(d["correct"].mean() * 100, 1),
                    "ci95": f"{lo * 100:.1f}–{hi * 100:.1f}",
                }
            )
    return pd.DataFrame(rows)


def paired_table(runs: dict[str, pd.DataFrame], ref: str) -> pd.DataFrame:
    rng = np.random.default_rng(SEED)
    base = runs[ref]
    rows = []
    for name, df in runs.items():
        if name == ref:
            continue
        m = base.merge(df, on=["task", "doc_id"], suffixes=("_ref", ""))
        mismatched = int((m["prompt_hash_ref"] != m["prompt_hash"]).sum())
        for subset, d in subsets(m).items():
            if not len(d):
                continue
            diff = (d["correct"] - d["correct_ref"]).to_numpy()
            lo, hi = boot_ci(diff, rng)
            b = int(((d["correct_ref"] == 1) & (d["correct"] == 0)).sum())  # lost
            c = int(((d["correct_ref"] == 0) & (d["correct"] == 1)).sum())  # gained
            div = [first_divergence(x, y) for x, y in zip(d["raw_ref"], d["raw"], strict=True)]
            div = [v for v in div if v is not None]
            rows.append(
                {
                    "run": name,
                    "vs": ref,
                    "set": subset,
                    "n_paired": len(d),
                    "diff_pp": round(diff.mean() * 100, 1),
                    "ci95_pp": f"{lo * 100:+.1f} to {hi * 100:+.1f}",
                    "lost": b,
                    "gained": c,
                    "mcnemar_p": round(mcnemar_exact(b, c), 4),
                    "same_answer": f"{(d['answer'] == d['answer_ref']).mean():.0%}",
                    "same_text": f"{(d['raw'] == d['raw_ref']).mean():.0%}",
                    "median_divergence_char": int(np.median(div)) if div else None,
                    "prompt_mismatch": mismatched,
                }
            )
    return pd.DataFrame(rows)


def usage_summary(eval_dir: Path) -> dict:
    f = eval_dir / "usage.jsonl"
    if not f.exists():
        return {}
    u = pd.read_json(f, lines=True)
    if not len(u):
        return {}
    return {
        "responses": len(u),
        "prompt_tokens": int(u["prompt_tokens"].fillna(0).sum()),
        "completion_tokens": int(u["completion_tokens"].fillna(0).sum()),
        "billed_usd": round(float(u["cost"].fillna(0).sum()), 4),
        "reasoning_responses": int((u["reasoning_tokens"].fillna(0) > 0).sum()),
        "truncated": int((u["finish_reason"] == "length").sum()),
        "providers": ",".join(sorted(u["provider"].dropna().astype(str).unique())),
    }


# -------------------------------------------------------------------------------------- main


def write(out: Path, name: str, title: str, df: pd.DataFrame, note: str = "") -> None:
    out.mkdir(parents=True, exist_ok=True)
    df.to_csv(out / f"{name}.csv", index=False)
    (out / f"{name}.md").write_text(f"# {title}\n\n{note}{md_table(df)}\n")
    print(f"{out / name}.md ({len(df)} rows)")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("breakeven")
    b.add_argument("--runs", nargs="*", type=Path)
    a = sub.add_parser("api")
    a.add_argument("runs", nargs="+", type=Path)
    q = sub.add_parser("quality")
    q.add_argument("evals", nargs="+", type=Path)
    q.add_argument("--ref", type=Path, required=True)
    for p in (b, a, q):
        p.add_argument("--out", type=Path, default=ROOT / "results" / "exp2")
    args = ap.parse_args(argv)

    if args.cmd == "breakeven":
        df = breakeven(our_runs(args.runs))
        note = f"API prices: bench/api/providers.yaml, snapshot {df.attrs.get('snapshot')}.\n\n"
        write(args.out, "breakeven", "Break-even load U*", df, note)
    elif args.cmd == "api":
        df = pd.concat([api_points(r) for r in args.runs], ignore_index=True)
        write(args.out, "api_latency", "Hosted APIs: latency, errors and cost", df)
    else:
        dirs = list(dict.fromkeys([args.ref, *args.evals]))
        runs = {d.name: load_eval(d) for d in dirs}
        acc = accuracy_table(runs)
        pair = paired_table(runs, args.ref.name)
        usage = pd.DataFrame([{"run": d.name, **usage_summary(d)} for d in dirs])
        write(args.out, "quality_accuracy", "Accuracy with 95% bootstrap intervals", acc)
        write(args.out, "quality_paired", f"Paired against {args.ref.name}", pair)
        write(args.out, "quality_usage", "Tokens, cost and reasoning per eval run", usage)
    return 0


if __name__ == "__main__":
    sys.exit(main())
