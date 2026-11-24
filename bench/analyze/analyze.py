#!/usr/bin/env python3
"""Turns raw loadgen runs into tables, capacity, cost and charts (methodology §5–§8).

  analyze.py report     <run_dir> [--price 0.42]   → <run_dir>/analysis/{summary.csv,report.md,*.png}
  analyze.py compare    <run_a> <run_b> [--out f]  → side-by-side deltas (e.g. direct vs gateway)
  analyze.py crosscheck <run_dir>                  → loadgen vs `vllm bench serve` (bench/crosscheck.sh)

All statistics are computed here from per-request records; loadgen's own quick summary is only
used to decide when to stop the concurrency ladder.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import yaml

P99_MIN_SAMPLES = 300  # methodology §4.2

# Chart styling: reference palette of the dataviz guide (light surface).
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_2 = "#52514e"
MUTED = "#898781"
GRID = "#e6e5e1"
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]


# --------------------------------------------------------------------------------------- loading


@dataclass
class Point:
    scenario: str
    pattern: str  # "concurrency" | "rate"
    value: float
    meta: dict
    records: pd.DataFrame


@dataclass
class Run:
    path: Path
    meta: dict
    env: dict
    scenarios: dict[str, dict]
    points: list[Point] = field(default_factory=list)

    @property
    def label(self) -> str:
        return self.meta.get("label") or self.path.name


def load_run(path: str | Path) -> Run:
    root = Path(path)
    if not (root / "run.json").exists():
        sys.exit(f"{root}: not a loadgen run directory (no run.json)")
    meta = json.loads((root / "run.json").read_text())
    env = json.loads((root / "env.json").read_text()) if (root / "env.json").exists() else {}
    scenarios = {
        f.stem: yaml.safe_load(f.read_text()) for f in sorted((root / "scenarios").glob("*.yaml"))
    }
    run = Run(root, meta, env, scenarios)
    for point_file in sorted((root / "points").glob("*/*/point.json")):
        pmeta = json.loads(point_file.read_text())
        with gzip.open(point_file.parent / "requests.jsonl.gz", "rt") as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
        records = pd.DataFrame(rows)
        run.points.append(
            Point(pmeta["scenario"], pmeta["pattern"], float(pmeta["value"]), pmeta, records)
        )
    run.points.sort(key=lambda p: (p.scenario, p.pattern, p.value))
    return run


# ------------------------------------------------------------------------------------ statistics


def pct(values, q: float) -> float:
    arr = np.asarray([v for v in values if v is not None and not math.isnan(v)], dtype=float)
    return float(np.percentile(arr, q)) if arr.size else math.nan


def request_tpot(row) -> float:
    """(E2E − TTFT) / (output tokens − 1); output tokens from usage, else token chunks."""
    if row["error"] is not None or row["ttft"] is None or pd.isna(row["ttft"]):
        return math.nan
    tokens = row["completionTokens"]
    if tokens is None or pd.isna(tokens):
        tokens = row["tokenChunks"]
    return (row["e2e"] - row["ttft"]) / (tokens - 1) if tokens > 1 else math.nan


def steady_state(point: Point, m: pd.DataFrame) -> tuple[float, float, float, float] | None:
    """Throughput while the load was fully applied: [end of warm-up, last measured request start].

    Token emission times are rebuilt from each request's start, TTFT and inter-token gaps, so tokens
    from warm-up requests still generating inside the window count, and the ramp-down after the last
    request start does not dilute the rate. Returns (window_s, output tok/s, total tok/s, req/s).
    """
    warmup_end = point.meta.get("warmupEndMs")
    if warmup_end is None or m.empty:
        return None
    t0, t1 = float(warmup_end), float(m["start"].max())
    if t1 - t0 < 1000:  # less than a second of full load: not meaningful
        return None
    df = point.records
    out_tokens = prompt_tokens = 0.0
    for r in df[df["error"].isna() & df["ttft"].notna()].itertuples():
        times = np.asarray([r.ttft, *r.itl], dtype=float).cumsum() + r.start
        inside = int(((times >= t0) & (times < t1)).sum())
        chunks = max(r.tokenChunks, 1)
        per_chunk = (
            (r.completionTokens / chunks) if r.completionTokens == r.completionTokens else 1.0
        )
        out_tokens += inside * per_chunk
        first = r.start + r.ttft
        if t0 <= first < t1 and r.promptTokens == r.promptTokens and r.promptTokens is not None:
            prompt_tokens += r.promptTokens  # prefill finished inside the window
    ends = df["start"] + df["e2e"]
    done = int((df["error"].isna() & (ends >= t0) & (ends < t1)).sum())
    window_s = (t1 - t0) / 1000
    return window_s, out_tokens / window_s, (out_tokens + prompt_tokens) / window_s, done / window_s


def point_stats(point: Point) -> dict:
    df = point.records
    slo = point.meta["slo"]
    m = df[~df["warmup"]].copy()
    m["error"] = m["error"].where(m["error"].notna(), None)
    ok = m[m["error"].isna()].copy()
    ok["tpot"] = ok.apply(request_tpot, axis=1) if len(ok) else pd.Series(dtype=float)
    out_tokens = (
        ok["completionTokens"].fillna(ok["tokenChunks"]) if len(ok) else pd.Series(dtype=float)
    )

    if len(m):
        window_s = max((m["start"] + m["e2e"]).max() - m["start"].min(), 1e-9) / 1000
    else:
        window_s = math.nan
    itl = [x for lst in ok["itl"] for x in lst] if len(ok) else []
    good = 0
    if len(ok):
        meets_tpot = ok["tpot"].isna() | (ok["tpot"] <= slo["tpotP95Ms"])
        good = int(((ok["ttft"] <= slo["ttftP95Ms"]) & meets_tpot).sum())

    n = len(m)
    error_rate = (n - len(ok)) / n if n else math.nan
    steady = steady_state(point, m)
    s = {
        "scenario": point.scenario,
        "pattern": point.pattern,
        "value": point.value,
        "n": n,
        "errors": n - len(ok),
        "error_rate": error_rate,
        "error_codes": ", ".join(sorted(set(m["error"].dropna()))) if n else "",
        "ttft_p50": pct(ok["ttft"], 50),
        "ttft_p90": pct(ok["ttft"], 90),
        "ttft_p95": pct(ok["ttft"], 95),
        "ttft_p99": pct(ok["ttft"], 99) if n >= P99_MIN_SAMPLES else math.nan,
        "tpot_p50": pct(ok["tpot"], 50) if len(ok) else math.nan,
        "tpot_p95": pct(ok["tpot"], 95) if len(ok) else math.nan,
        "tpot_p99": pct(ok["tpot"], 99) if len(ok) and n >= P99_MIN_SAMPLES else math.nan,
        "itl_p50": pct(itl, 50),
        # ITL percentiles are over token gaps, not requests: thousands of samples per point.
        "itl_p99": pct(itl, 99) if len(itl) >= P99_MIN_SAMPLES else math.nan,
        "e2e_p50": pct(ok["e2e"], 50),
        "e2e_p95": pct(ok["e2e"], 95),
        "prompt_tokens_mean": float(ok["promptTokens"].dropna().mean()) if len(ok) else math.nan,
        "output_tokens_mean": float(out_tokens.mean()) if len(ok) else math.nan,
        # Throughput: steady state when the point is long enough, else measured requests over
        # their own span (first start → last end, which includes ramp-down).
        "throughput_basis": "steady" if steady else "span",
        "window_s": steady[0] if steady else window_s,
        "req_per_s": steady[3] if steady else (len(ok) / window_s if n else math.nan),
        "output_tok_per_s": steady[1]
        if steady
        else (float(out_tokens.sum()) / window_s if n else math.nan),
        "total_tok_per_s": steady[2]
        if steady
        else (
            (float(out_tokens.sum()) + float(ok["promptTokens"].fillna(0).sum())) / window_s
            if n
            else math.nan
        ),
        # Share of successful requests that met the per-request SLO, at the same rate basis.
        "goodput_req_per_s": (steady[3] * good / len(ok) if len(ok) else 0.0)
        if steady
        else (good / window_s if n else math.nan),
        "client_elu": point.meta.get("client", {}).get("eventLoopUtilization", math.nan),
        "client_valid": bool(point.meta.get("client", {}).get("valid", True)),
        "dropped": point.meta.get("client", {}).get("dropped", 0),
        "p99_reliable": n >= P99_MIN_SAMPLES,
    }
    s["slo_ok"] = bool(
        n > 0
        and error_rate <= slo["maxErrorRate"]
        and not math.isnan(s["ttft_p95"])
        and s["ttft_p95"] <= slo["ttftP95Ms"]
        and (math.isnan(s["tpot_p95"]) or s["tpot_p95"] <= slo["tpotP95Ms"])
    )
    return s


def summarize(run: Run) -> pd.DataFrame:
    return pd.DataFrame([point_stats(p) for p in run.points])


def cost_per_million(price_per_hour: float | None, tokens_per_s: float) -> float:
    if not price_per_hour or not tokens_per_s or math.isnan(tokens_per_s):
        return math.nan
    return price_per_hour / (tokens_per_s * 3600) * 1_000_000


def capacity(df: pd.DataFrame, price: float | None) -> pd.DataFrame:
    """Highest SLO-compliant, client-valid load per scenario and pattern (methodology §5.1, §6)."""
    rows = []
    for (scenario, pattern), g in df.groupby(["scenario", "pattern"]):
        ok = g[g["slo_ok"] & g["client_valid"]]
        best = ok.loc[ok["value"].idxmax()] if len(ok) else None
        rows.append(
            {
                "scenario": scenario,
                "pattern": pattern,
                "capacity": best["value"] if best is not None else math.nan,
                "output_tok_per_s": best["output_tok_per_s"] if best is not None else math.nan,
                "total_tok_per_s": best["total_tok_per_s"] if best is not None else math.nan,
                "usd_per_1m_output": cost_per_million(price, best["output_tok_per_s"])
                if best is not None
                else math.nan,
                "usd_per_1m_total": cost_per_million(price, best["total_tok_per_s"])
                if best is not None
                else math.nan,
            }
        )
    return pd.DataFrame(rows)


# ------------------------------------------------------------------------------------- rendering


def fmt(v, digits: int = 0, suffix: str = "") -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "–"
    return f"{v:,.{digits}f}{suffix}"


def point_name(row) -> str:
    return (
        f"c={int(row['value'])}" if row["pattern"] == "concurrency" else f"{row['value']:g} req/s"
    )


def scenario_table(g: pd.DataFrame) -> str:
    head = (
        "| Load | n | Errors | TTFT p50 / p95 / p99 (ms) | TPOT p50 / p95 (ms) | ITL p99 (ms) "
        "| Output tok/s | Req/s | Goodput req/s | SLO | Notes |\n"
        "|---|---:|---:|---|---|---:|---:|---:|---:|:-:|---|\n"
    )
    lines = []
    for _, r in g.iterrows():
        notes = []
        if not r["client_valid"]:
            notes.append(f"client-bound (ELU {r['client_elu']:.2f}) — invalid")
        if not r["p99_reliable"]:
            notes.append(f"p99 n/a (n={r['n']})")
        if r["dropped"]:
            notes.append(f"{r['dropped']} dropped")
        if r["error_codes"]:
            notes.append(r["error_codes"])
        lines.append(
            f"| {point_name(r)} | {r['n']} | {fmt(r['error_rate'] * 100, 1, '%')} "
            f"| {fmt(r['ttft_p50'])} / {fmt(r['ttft_p95'])} / {fmt(r['ttft_p99'])} "
            f"| {fmt(r['tpot_p50'], 1)} / {fmt(r['tpot_p95'], 1)} | {fmt(r['itl_p99'], 1)} "
            f"| {fmt(r['output_tok_per_s'])} | {fmt(r['req_per_s'], 2)} | {fmt(r['goodput_req_per_s'], 2)} "
            f"| {'✓' if r['slo_ok'] else '✗'} | {'; '.join(notes)} |"
        )
    return head + "\n".join(lines) + "\n"


def style_axes(ax, title: str, ylabel: str) -> None:
    ax.set_facecolor(SURFACE)
    ax.set_title(title, loc="left", fontsize=11, color=INK)
    ax.set_ylabel(ylabel, color=INK_2, fontsize=9)
    ax.set_xlabel("concurrent requests", color=INK_2, fontsize=9)
    ax.grid(True, color=GRID, linewidth=1, linestyle="-")
    ax.set_axisbelow(True)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    for spine in ("left", "bottom"):
        ax.spines[spine].set_color(GRID)
    ax.tick_params(colors=MUTED, labelsize=8)


def ladder_chart(series: list[tuple[str, pd.DataFrame]], slo: dict, title: str, out: Path) -> None:
    """Small multiples (TTFT p95, TPOT p95, output tok/s) against concurrency, one line per run."""
    fig, axes = plt.subplots(1, 3, figsize=(13, 3.8), facecolor=SURFACE)
    panels = [
        ("ttft_p95", "TTFT p95", "ms", slo.get("ttftP95Ms")),
        ("tpot_p95", "TPOT p95", "ms", slo.get("tpotP95Ms")),
        ("output_tok_per_s", "Output throughput", "tokens/s", None),
    ]
    for ax, (col, name, unit, limit) in zip(axes, panels, strict=True):
        style_axes(ax, name, unit)
        ax.set_xscale("log", base=2)
        for idx, (label, g) in enumerate(series):
            g = g.sort_values("value")
            color = SERIES[idx % len(SERIES)]
            ax.plot(
                g["value"], g[col], color=color, linewidth=2, solid_capstyle="round", label=label
            )
            ax.scatter(
                g["value"], g[col], s=36, color=color, edgecolors=SURFACE, linewidths=2, zorder=3
            )
            bad = g[~g["client_valid"]]
            if len(bad):
                ax.scatter(
                    bad["value"], bad[col], s=80, facecolors="none", edgecolors=INK_2, zorder=4
                )
        if limit:
            ax.axhline(limit, color=MUTED, linewidth=1)
            ax.annotate(
                f"SLO {limit:g} {unit}",
                xy=(1, limit),
                xycoords=("axes fraction", "data"),
                xytext=(-2, 3),
                textcoords="offset points",
                ha="right",
                fontsize=8,
                color=INK_2,
            )
        ticks = sorted({int(v) for _, g in series for v in g["value"]})
        ax.set_xticks(ticks, [str(t) for t in ticks])
        ax.minorticks_off()
        ax.set_ylim(bottom=0)
    if len(series) > 1:
        axes[0].legend(frameon=False, fontsize=8, labelcolor=INK_2)
    fig.suptitle(title, x=0.01, ha="left", fontsize=12, color=INK)
    fig.tight_layout()
    fig.savefig(out, dpi=150, facecolor=SURFACE)
    plt.close(fig)


def env_lines(run: Run, price: float | None) -> list[str]:
    env = run.env or {}
    gpu = (env.get("gpu") or {}).get("devices") or []
    server = env.get("server") or {}
    version = (
        (server.get("version") or {}).get("version")
        if isinstance(server.get("version"), dict)
        else None
    )
    cal = run.meta.get("calibration", {})
    return [
        f"- **GPU:** {', '.join(d.get('name', '?') for d in gpu) or 'none (local)'}"
        + (
            f" · driver {gpu[0].get('driver_version')} · PCIe gen{gpu[0].get('pcie.link.gen.current')} "
            f"x{gpu[0].get('pcie.link.width.current')}"
            if gpu
            else ""
        ),
        (
            f"- **Provider / price:** {env.get('provider') or '–'} · "
            f"{f'${price:.2f}/h' if price else 'price not set (GPU_PRICE_PER_HOUR_USD or --price)'}"
        ),
        f"- **Server:** {server.get('url', run.meta.get('target'))} · model `{run.meta.get('model')}`"
        + (f" · vLLM {version}" if version else ""),
        (
            f"- **Methodology:** {env.get('methodologyVersion') or '–'} · "
            f"loadgen {run.meta.get('loadgenVersion')} · "
            f"repo {((env.get('repo') or {}).get('commit') or '–')[:10]}"
        ),
        f"- **Prompt calibration:** {cal.get('tokensPerWord', math.nan):.3f} tokens/word ({cal.get('source')})",
        f"- **Run:** {run.meta.get('startedAt')} → {run.meta.get('finishedAt', '–')}",
    ]


def cmd_report(args) -> None:
    run = load_run(args.run)
    df = summarize(run)
    price = args.price if args.price is not None else (run.env or {}).get("pricePerHourUsd")
    cap = capacity(df, price)
    out = run.path / "analysis"
    out.mkdir(exist_ok=True)
    df.to_csv(out / "summary.csv", index=False)
    cap.to_csv(out / "capacity.csv", index=False)

    md = [f"# Benchmark report — {run.label}", "", *env_lines(run, price), ""]
    for scenario, g in df.groupby("scenario", sort=False):
        sc = run.scenarios.get(scenario, {})
        slo = sc.get("slo") or run.points[0].meta["slo"]
        shape = (
            f"{sc.get('inputTokens')} → {sc.get('outputTokens')} tokens"
            if sc.get("kind", "synthetic") == "synthetic"
            else f"dataset {sc.get('dataset')}"
        )
        md += [
            f"## {scenario}",
            "",
            (
                f"{shape}. SLO: TTFT p95 ≤ {slo['ttftP95Ms']} ms, TPOT p95 ≤ {slo['tpotP95Ms']} ms, "
                f"errors < {slo['maxErrorRate'] * 100:g}%."
            ),
            "",
        ]
        for pattern, title in (("concurrency", "Closed loop"), ("rate", "Open loop (Poisson)")):
            gp = g[g["pattern"] == pattern]
            if len(gp):
                md += [f"**{title}**", "", scenario_table(gp)]
        for _, c in cap[cap["scenario"] == scenario].iterrows():
            unit = "concurrent requests" if c["pattern"] == "concurrency" else "req/s"
            md.append(
                f"- **Capacity ({c['pattern']}):** {fmt(c['capacity'], 0 if c['pattern'] == 'concurrency' else 2)} "
                f"{unit} · {fmt(c['output_tok_per_s'])} output tok/s · "
                f"${fmt(c['usd_per_1m_output'], 3)} per 1M output tokens · "
                f"${fmt(c['usd_per_1m_total'], 3)} per 1M total tokens"
            )
        ladder = g[g["pattern"] == "concurrency"]
        if len(ladder):
            chart = out / f"{scenario}.png"
            ladder_chart([(run.label, ladder)], slo, f"{scenario} — {run.label}", chart)
            md += ["", f"![{scenario}]({chart.name})", ""]
    md += [
        (
            "Cost assumes the GPU is fully used at the capacity point; setup and idle time are "
            "excluded (methodology §6). p99 is shown only with ≥ 300 samples; points where the load "
            "generator was the bottleneck are marked invalid and excluded from capacity."
        ),
        "",
    ]
    (out / "report.md").write_text("\n".join(md))
    print(out / "report.md")


def cmd_compare(args) -> None:
    a, b = load_run(args.run_a), load_run(args.run_b)
    da, db = summarize(a), summarize(b)
    keys = ["scenario", "pattern", "value"]
    j = da.merge(db, on=keys, suffixes=("_a", "_b"))
    md = [
        f"# {b.label} vs {a.label}",
        "",
        (
            "Positive Δ = B is higher than A. For a gateway-overhead comparison (methodology §7) "
            "A is the direct run and B the run through the gateway."
        ),
        "",
        "| Scenario | Load | TTFT p50 A → B (Δ ms) | TTFT p95 A → B (Δ ms) | Output tok/s A → B (Δ %) |",
        "|---|---|---|---|---|",
    ]
    for _, r in j.iterrows():
        tput = (
            (r["output_tok_per_s_b"] / r["output_tok_per_s_a"] - 1) * 100
            if r["output_tok_per_s_a"]
            else math.nan
        )
        md.append(
            f"| {r['scenario']} | {point_name(r)} "
            f"| {fmt(r['ttft_p50_a'])} → {fmt(r['ttft_p50_b'])} ({fmt(r['ttft_p50_b'] - r['ttft_p50_a'], 1)}) "
            f"| {fmt(r['ttft_p95_a'])} → {fmt(r['ttft_p95_b'])} ({fmt(r['ttft_p95_b'] - r['ttft_p95_a'], 1)}) "
            f"| {fmt(r['output_tok_per_s_a'])} → {fmt(r['output_tok_per_s_b'])} ({fmt(tput, 1, '%')}) |"
        )
    out_file = Path(args.out) if args.out else b.path / "analysis" / f"compare-vs-{a.path.name}.md"
    out_file.parent.mkdir(parents=True, exist_ok=True)
    for scenario in sorted(set(j["scenario"])):
        sa = da[(da["scenario"] == scenario) & (da["pattern"] == "concurrency")]
        sb = db[(db["scenario"] == scenario) & (db["pattern"] == "concurrency")]
        if len(sa) and len(sb):
            slo = a.points[0].meta["slo"] if a.points else {}
            for p in a.points:
                if p.scenario == scenario:
                    slo = p.meta["slo"]
                    break
            chart = out_file.parent / f"compare-{scenario}.png"
            ladder_chart(
                [(a.label, sa), (b.label, sb)], slo, f"{scenario}: {a.label} vs {b.label}", chart
            )
            md += ["", f"![{scenario}]({chart.name})"]
    out_file.write_text("\n".join(md) + "\n")
    print(out_file)


CROSSCHECK_RE = re.compile(r"vllm-bench_c(\d+)_(\d+)x(\d+)\.json$")


def cmd_crosscheck(args) -> None:
    run = load_run(args.run)
    df = summarize(run)
    files = sorted((run.path / "crosscheck").glob("vllm-bench_*.json"))
    if not files:
        sys.exit(f"{run.path}/crosscheck: no vllm-bench_*.json (run bench/crosscheck.sh first)")
    md = [
        f"# Cross-check: loadgen vs vllm bench serve — {run.label}",
        "",
        "| Point | Metric | loadgen | vllm bench | Δ % |",
        "|---|---|---:|---:|---:|",
    ]
    for f in files:
        m = CROSSCHECK_RE.search(f.name)
        if not m:
            continue
        c, inp, outp = (int(x) for x in m.groups())
        ref = json.loads(f.read_text())
        scen = next(
            (
                n
                for n, s in run.scenarios.items()
                if s.get("inputTokens") == inp and s.get("outputTokens") == outp
            ),
            None,
        )
        row = df[(df["scenario"] == scen) & (df["pattern"] == "concurrency") & (df["value"] == c)]
        if scen is None or row.empty:
            md.append(f"| {f.name} | – | no matching loadgen point | | |")
            continue
        r = row.iloc[0]
        pairs = [
            ("TTFT p50 (ms)", r["ttft_p50"], ref.get("median_ttft_ms")),
            ("TTFT p99 (ms)", r["ttft_p99"], ref.get("p99_ttft_ms")),
            ("TPOT p50 (ms)", r["tpot_p50"], ref.get("median_tpot_ms")),
            ("Output tok/s", r["output_tok_per_s"], ref.get("output_throughput")),
            ("Req/s", r["req_per_s"], ref.get("request_throughput")),
        ]
        for name, ours, theirs in pairs:
            delta = (ours / theirs - 1) * 100 if theirs and not math.isnan(ours) else math.nan
            md.append(
                f"| {scen} c={c} | {name} | {fmt(ours, 1)} | {fmt(theirs, 1)} | {fmt(delta, 1, '%')} |"
            )
    out = run.path / "analysis"
    out.mkdir(exist_ok=True)
    (out / "crosscheck.md").write_text("\n".join(md) + "\n")
    print(out / "crosscheck.md")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = p.add_subparsers(dest="command", required=True)
    r = sub.add_parser("report")
    r.add_argument("run")
    r.add_argument("--price", type=float, help="GPU price per hour, USD (overrides env.json)")
    c = sub.add_parser("compare")
    c.add_argument("run_a")
    c.add_argument("run_b")
    c.add_argument("--out")
    x = sub.add_parser("crosscheck")
    x.add_argument("run")
    args = p.parse_args(argv)
    {"report": cmd_report, "compare": cmd_compare, "crosscheck": cmd_crosscheck}[args.command](args)


if __name__ == "__main__":
    main()
