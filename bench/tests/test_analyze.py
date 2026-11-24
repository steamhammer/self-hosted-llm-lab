import gzip
import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "analyze"))
import analyze

SLO = {"ttftP95Ms": 500, "tpotP95Ms": 20, "maxErrorRate": 0.01}


def record(i, *, warmup=False, start=0.0, ttft=100.0, e2e=1100.0, out=101, error=None, prompt=50):
    return {
        "i": i,
        "warmup": warmup,
        "start": start,
        "ttft": None if error else ttft,
        "e2e": e2e,
        "itl": [] if error else [10.0] * (out - 1),
        "promptTokens": None if error else prompt,
        "completionTokens": None if error else out,
        "tokenChunks": 0 if error else out,
        "status": 503 if error else 200,
        "error": error,
    }


def write_run(
    root: Path,
    points: dict[tuple[str, int], list[dict]],
    valid: dict | None = None,
    price=None,
    warmup_end: dict | None = None,
):
    root.mkdir(parents=True)
    (root / "run.json").write_text(
        json.dumps(
            {
                "label": root.name,
                "model": "m",
                "target": "http://x",
                "loadgenVersion": "t",
                "calibration": {"tokensPerWord": 1.0, "source": "tokenize"},
            }
        )
    )
    (root / "env.json").write_text(
        json.dumps({"pricePerHourUsd": price, "methodologyVersion": "1.1"})
    )
    (root / "scenarios").mkdir()
    (root / "scenarios" / "chat.yaml").write_text(
        "name: chat\nkind: synthetic\ninputTokens: 512\noutputTokens: 256\n"
        f"slo: {json.dumps(SLO)}\n"
    )
    for (pattern, value), recs in points.items():
        d = root / "points" / "chat" / f"{'c' if pattern == 'concurrency' else 'r'}{value}"
        d.mkdir(parents=True)
        ok = (valid or {}).get((pattern, value), True)
        (d / "point.json").write_text(
            json.dumps(
                {
                    "scenario": "chat",
                    "pattern": pattern,
                    "value": value,
                    "slo": SLO,
                    "warmupEndMs": (warmup_end or {}).get((pattern, value)),
                    "client": {
                        "eventLoopUtilization": 0.1 if ok else 0.95,
                        "valid": ok,
                        "dropped": 0,
                    },
                }
            )
        )
        with gzip.open(d / "requests.jsonl.gz", "wt") as fh:
            fh.writelines(json.dumps(r) + "\n" for r in recs)
    return root


def steady(n, *, ttft=100.0, spacing=1000.0, out=101, e2e=1100.0):
    return [record(i, start=i * spacing, ttft=ttft, out=out, e2e=e2e) for i in range(n)]


def test_percentile_matches_numpy():
    xs = [5, 1, 9, 3, 7, 2]
    for q in (50, 90, 95, 99):
        assert analyze.pct(xs, q) == pytest.approx(np.percentile(xs, q))
    assert math.isnan(analyze.pct([], 50))


def test_point_stats_excludes_warmup_and_computes_rates(tmp_path):
    recs = [record(0, warmup=True, ttft=9999)] + steady(10)
    run = analyze.load_run(write_run(tmp_path / "r", {("concurrency", 1): recs}))
    s = analyze.point_stats(run.points[0])
    assert s["n"] == 10
    assert s["ttft_p95"] == pytest.approx(100)
    assert s["tpot_p50"] == pytest.approx(10)  # (1100-100)/(101-1)
    # window: first start 0 → last end 9000+1100 = 10.1 s; 10 requests × 101 tokens
    assert s["req_per_s"] == pytest.approx(10 / 10.1)
    assert s["output_tok_per_s"] == pytest.approx(1010 / 10.1)
    assert s["total_tok_per_s"] == pytest.approx((1010 + 500) / 10.1)
    assert s["slo_ok"] is True
    assert math.isnan(s["ttft_p99"])  # n < 300
    assert not math.isnan(s["itl_p99"])  # 1000 token gaps


def test_errors_and_slo_violations(tmp_path):
    recs = steady(98) + [record(98, error="overloaded"), record(99, error="overloaded")]
    slow = steady(20, ttft=800)
    run = analyze.load_run(
        write_run(tmp_path / "r", {("concurrency", 1): recs, ("concurrency", 2): slow})
    )
    df = analyze.summarize(run)
    c1 = df[df["value"] == 1].iloc[0]
    assert c1["error_rate"] == pytest.approx(0.02)
    assert c1["error_codes"] == "overloaded"
    assert not c1["slo_ok"]  # 2% errors > 1%
    c2 = df[df["value"] == 2].iloc[0]
    assert not c2["slo_ok"]
    assert c2["goodput_req_per_s"] == 0


def test_capacity_skips_violations_and_client_bound_points(tmp_path):
    points = {
        ("concurrency", 1): steady(30),
        ("concurrency", 4): steady(30, spacing=250),
        ("concurrency", 8): steady(30, spacing=125),  # fine, but client-bound → excluded
        ("concurrency", 16): steady(30, ttft=900),  # violates TTFT
    }
    run = analyze.load_run(
        write_run(tmp_path / "r", points, valid={("concurrency", 8): False}, price=1.8)
    )
    cap = analyze.capacity(analyze.summarize(run), 1.8)
    row = cap[cap["pattern"] == "concurrency"].iloc[0]
    assert row["capacity"] == 4
    expected = 1.8 / (row["output_tok_per_s"] * 3600) * 1e6
    assert row["usd_per_1m_output"] == pytest.approx(expected)


def test_cost_formula():
    # $3.60/h at 1000 tok/s → 3.6M tokens per hour → $1 per 1M
    assert analyze.cost_per_million(3.6, 1000) == pytest.approx(1.0)
    assert math.isnan(analyze.cost_per_million(None, 1000))


def test_report_and_compare_write_files(tmp_path):
    a = write_run(
        tmp_path / "direct",
        {("concurrency", 1): steady(30), ("concurrency", 2): steady(30, spacing=500)},
    )
    b = write_run(
        tmp_path / "gateway",
        {
            ("concurrency", 1): steady(30, ttft=103),
            ("concurrency", 2): steady(30, ttft=104, spacing=500),
        },
    )
    analyze.main(["report", str(a), "--price", "0.5"])
    report = (a / "analysis" / "report.md").read_text()
    assert "## chat" in report
    assert "Capacity (concurrency):** 2" in report
    assert (a / "analysis" / "chat.png").stat().st_size > 10_000
    assert (a / "analysis" / "summary.csv").exists()

    analyze.main(["compare", str(a), str(b)])
    cmp = (b / "analysis" / "compare-vs-direct.md").read_text()
    assert "| chat | c=1 | 100 → 103 (3.0)" in cmp
    assert (b / "analysis" / "compare-chat.png").exists()


def test_crosscheck_matches_points_by_shape(tmp_path):
    run = write_run(tmp_path / "r", {("concurrency", 16): steady(30)})
    (run / "crosscheck").mkdir()
    (run / "crosscheck" / "vllm-bench_c16_512x256.json").write_text(
        json.dumps(
            {
                "median_ttft_ms": 110.0,
                "p99_ttft_ms": 150.0,
                "median_tpot_ms": 10.0,
                "output_throughput": 100.0,
                "request_throughput": 1.0,
            }
        )
    )
    analyze.main(["crosscheck", str(run)])
    text = (run / "analysis" / "crosscheck.md").read_text()
    assert "| chat c=16 | TTFT p50 (ms) | 100.0 | 110.0 | -9.1% |" in text


def test_steady_state_throughput_ignores_ramp_down(tmp_path):
    # Two workers back to back, each request: TTFT 100 ms, then 100 tokens 10 ms apart (1.1 s).
    recs = []
    for w in range(2):
        for k in range(10):
            recs.append(record(len(recs), start=k * 1100.0 + w * 0.1, warmup=k == 0))
    run = analyze.load_run(
        write_run(
            tmp_path / "r", {("concurrency", 2): recs}, warmup_end={("concurrency", 2): 1100.0}
        )
    )
    s = analyze.point_stats(run.points[0])
    assert s["throughput_basis"] == "steady"
    # 2 streams × 1 token / 10 ms = 200 tok/s while both run (101 tokens per 1.1 s ≈ 183.6)
    assert s["output_tok_per_s"] == pytest.approx(2 * 101 / 1.1, rel=0.03)
    assert s["req_per_s"] == pytest.approx(2 / 1.1, rel=0.1)
