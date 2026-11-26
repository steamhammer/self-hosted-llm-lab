"""bench/analyze/exp2.py: break-even arithmetic and the paired quality comparison."""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "analyze"))
import exp2


def test_model_size_and_api_unit():
    assert exp2.model_size("Qwen/Qwen3.5-27B-FP8") == "27b"
    assert exp2.model_size("qwen/qwen3.5-9b") == "9b"
    # chat: 2 input tokens per output token, so 2 × $0.26 + $2.60
    ep = {"input": 0.26, "output": 2.60}
    assert exp2.api_price_per_1m_output(ep, 2.0) == pytest.approx(3.12)
    assert exp2.scenario_ratio("chat") == 2.0


def test_breakeven_matches_models_and_flags_never(tmp_path):
    run = tmp_path / "2026-11-25_rtx4090_qwen3.5-9b.24gb_1"
    (run / "analysis").mkdir(parents=True)
    (run / "run.json").write_text(json.dumps({"label": "4090", "model": "Qwen/Qwen3.5-9B"}))
    pd.DataFrame(
        [
            {"scenario": "chat", "pattern": "concurrency", "usd_per_1m_output": 0.23},
            {"scenario": "chat", "pattern": "rate", "usd_per_1m_output": 0.1},
        ]
    ).to_csv(run / "analysis" / "capacity.csv", index=False)
    providers = tmp_path / "p.yaml"
    providers.write_text(
        "snapshot: 2026-11-26\nendpoints:\n"
        "  - {id: cheap, model: qwen/qwen3.5-9b, provider: x, quantization: fp4, input: 0.08, output: 0.13}\n"
        "  - {id: big, model: qwen/qwen3.5-27b, provider: y, quantization: fp8, input: 1, output: 1}\n"
        "  - {id: dear, model: qwen/qwen3.5-9b, provider: z, quantization: bf16, input: 0.01, output: 0.1}\n"
    )
    df = exp2.breakeven([run], providers)
    assert list(df["api"]) == ["cheap", "dear"]  # 27B endpoint skipped, rate row ignored
    cheap = df[df["api"] == "cheap"].iloc[0]
    assert cheap["api_usd_per_1m"] == pytest.approx(0.29)
    assert cheap["u_star"] == pytest.approx(0.23 / 0.29, abs=1e-3)
    assert df[df["api"] == "dear"].iloc[0]["pays_off"] == "never"


def test_mcnemar_exact():
    assert exp2.mcnemar_exact(0, 0) == 1.0
    assert exp2.mcnemar_exact(5, 5) == 1.0
    # 10 lost, 0 gained: p = 2 × 0.5^10
    assert exp2.mcnemar_exact(10, 0) == pytest.approx(2 / 1024)
    assert exp2.first_divergence("abc", "abc") is None
    assert exp2.first_divergence("abcd", "abxd") == 2
    assert exp2.first_divergence("ab", "abc") == 2


def write_eval(root: Path, name: str, gsm: list[int], mmlu: dict[str, list[int]]) -> Path:
    d = root / name
    (d / "samples").mkdir(parents=True)

    def dump(task: str, rows: list[dict]):
        with gzip.open(d / "samples" / f"{task}.jsonl.gz", "wt") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")

    gsm_rows = []
    for i, ok in enumerate(gsm):
        for flt in ("strict-match", "flexible-extract"):
            gsm_rows.append(
                {
                    "doc_id": i,
                    "filter": flt,
                    "prompt_hash": f"g{i}",
                    "exact_match": float(ok if flt == "flexible-extract" else 0),
                    "filtered_resps": [str(i if ok else -1)],
                    "resps": [[f"answer {i if ok else -1}"]],
                }
            )
    dump("gsm8k_cot_llama", gsm_rows)
    for subject, oks in mmlu.items():
        dump(
            f"mmlu_pro_{subject}",
            [
                {
                    "doc_id": i,
                    "filter": "custom-extract",
                    "prompt_hash": f"{subject}{i}",
                    "exact_match": float(ok),
                    "filtered_resps": ["A" if ok else "B"],
                    "resps": [["The answer is (A)" if ok else "The answer is (B)"]],
                }
                for i, ok in enumerate(oks)
            ],
        )
    return d


def test_quality_paired(tmp_path):
    ref = write_eval(tmp_path, "bf16", [1] * 40, {"math": [1] * 10, "history": [1] * 10})
    # int4 loses 8 GSM8K questions and 5 math questions, history unchanged
    q = write_eval(
        tmp_path, "int4", [0] * 8 + [1] * 32, {"math": [0] * 5 + [1] * 5, "history": [1] * 10}
    )
    runs = {"bf16": exp2.load_eval(ref), "int4": exp2.load_eval(q)}
    assert len(runs["bf16"][runs["bf16"]["group"] == "gsm8k_cot_llama"]) == 40  # primary filter

    acc = exp2.accuracy_table(runs)
    got = acc.set_index(["run", "set"])["accuracy"]
    assert got[("int4", "gsm8k_cot_llama")] == 80.0
    assert got[("int4", "mmlu_pro:quantitative")] == 50.0
    assert got[("int4", "mmlu_pro:knowledge")] == 100.0

    pair = exp2.paired_table(runs, "bf16").set_index("set")
    assert pair.loc["gsm8k_cot_llama", "diff_pp"] == -20.0
    assert pair.loc["gsm8k_cot_llama", "lost"] == 8 and pair.loc["gsm8k_cot_llama", "gained"] == 0
    assert pair.loc["gsm8k_cot_llama", "mcnemar_p"] == pytest.approx(2 / 256, abs=1e-4)
    assert pair.loc["mmlu_pro:knowledge", "same_text"] == "100%"
    assert pair.loc["mmlu_pro:knowledge", "diff_pp"] == 0.0
    assert (pair["prompt_mismatch"] == 0).all()
