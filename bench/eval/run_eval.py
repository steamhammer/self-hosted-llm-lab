#!/usr/bin/env python3
"""Quality run for experiment 2: the same three task sets on any OpenAI-compatible endpoint.

Our vLLM on a pod (thinking is already off in the serving config):
  python bench/eval/run_eval.py --url http://127.0.0.1:8000/v1/chat/completions \
      --model Qwen/Qwen3.5-27B-FP8 --label h100_qwen3.5-27b.fp8 --concurrency 64

A hosted API through OpenRouter, one provider pinned without fallback:
  OPENROUTER_API_KEY=... python bench/eval/run_eval.py \
      --url https://openrouter.ai/api/v1/chat/completions --key-env OPENROUTER_API_KEY \
      --model qwen/qwen3.5-27b --label api_deepinfra-fp8_27b --concurrency 8 \
      --extra-body '{"provider":{"only":["deepinfra/fp8"],"allow_fallbacks":false},"reasoning":{"effort":"none"}}'

Rehearsal: --limit 20 runs the first 20 questions of every task.

Writes <out>/results.json (scores), <out>/samples/<task>.jsonl.gz (every question with the raw
and the extracted answer: the paired comparison needs them), <out>/usage.jsonl (tokens, cost and
provider per response) and <out>/eval.json (what was run, with which versions).
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

# Task set fixed by docs/adr/0007; changing it needs a new ADR, not a flag.
TASKS = ["gsm8k_cot_llama", "mmlu_pro", "ifeval"]
MMLU_PRO_SAMPLE = HERE / "mmlu_pro_sample.json"
MAX_GEN_TOKS = 1024  # default for tasks that set none (GSM8K); MMLU-Pro sets 2048, IFEval 1280


def mmlu_pro_samples(path: Path = MMLU_PRO_SAMPLE) -> dict[str, list[int]]:
    """Fixed stratified sample: 100 questions per subject, indices into lm-eval's subtask docs."""
    if not path.exists():
        raise SystemExit(f"{path} is missing: create it with bench/eval/make_mmlu_pro_sample.py")
    return json.loads(path.read_text())["indices"]


def jsonable(value):
    try:
        json.dumps(value)
        return value
    except TypeError:
        return repr(value)


def write_samples(out: Path, samples: dict) -> dict[str, int]:
    (out / "samples").mkdir(parents=True, exist_ok=True)
    counts = {}
    for task, rows in samples.items():
        with gzip.open(out / "samples" / f"{task}.jsonl.gz", "wt") as fh:
            for row in rows:
                fh.write(json.dumps({k: jsonable(v) for k, v in row.items()}) + "\n")
        counts[task] = len(rows)
    return counts


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--url", required=True, help="full chat completions URL")
    ap.add_argument("--model", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--key-env", help="env var with the bearer key (hosted APIs)")
    ap.add_argument("--extra-body", default="", help="JSON object merged into every request")
    ap.add_argument("--tasks", default=",".join(TASKS))
    ap.add_argument("--limit", type=int, help="rehearsal: first N questions of every task")
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument(
        "--cache",
        type=Path,
        help="sqlite cache of responses: a re-run after a crash pays only for what is missing",
    )
    args = ap.parse_args(argv)

    import lab_lm  # noqa: F401  (registers the "lab-chat" model)
    import lm_eval

    tasks = [t for t in args.tasks.split(",") if t]
    out = args.out or ROOT / "results" / "eval" / f"{datetime.now():%Y-%m-%d}_{args.label}"
    out.mkdir(parents=True, exist_ok=True)
    usage_log = out / "usage.jsonl"
    if not args.cache:
        usage_log.unlink(missing_ok=True)  # with a cache, a re-run appends to the same log
    os.environ["LAB_EVAL_EXTRA_BODY"] = args.extra_body
    os.environ["LAB_EVAL_USAGE_LOG"] = str(usage_log)
    if args.key_env:
        os.environ["LAB_EVAL_KEY_ENV"] = args.key_env
    else:
        os.environ.pop("LAB_EVAL_KEY_ENV", None)

    samples = None
    if args.limit is None and "mmlu_pro" in tasks:
        samples = mmlu_pro_samples()

    model_args = {
        "model": args.model,
        "base_url": args.url,
        "num_concurrent": args.concurrency,
        "max_retries": 5,
        "max_gen_toks": MAX_GEN_TOKS,
        "tokenized_requests": False,
        "timeout": args.timeout,
    }
    started = datetime.now(UTC)
    t0 = time.monotonic()
    results = lm_eval.simple_evaluate(
        model="lab-chat",
        model_args=model_args,
        tasks=tasks,
        apply_chat_template=True,
        fewshot_as_multiturn=True,
        limit=args.limit,
        samples=samples,
        log_samples=True,
        use_cache=str(args.cache) if args.cache else None,
        bootstrap_iters=0,  # intervals come from bench/analyze/quality.py, paired across runs
    )
    if results is None:
        raise SystemExit("lm-eval returned no results")

    counts = write_samples(out, results.pop("samples", {}))
    (out / "results.json").write_text(
        json.dumps(
            {k: results.get(k) for k in ("results", "groups", "n-shot", "configs", "versions")},
            indent=2,
            default=repr,
        )
    )
    meta = {
        "label": args.label,
        "model": args.model,
        "url": args.url,
        "extraBody": json.loads(args.extra_body) if args.extra_body else {},
        "keyEnv": args.key_env,
        "tasks": tasks,
        "limit": args.limit,
        "mmluProSample": str(MMLU_PRO_SAMPLE.relative_to(ROOT)) if samples else None,
        "concurrency": args.concurrency,
        "samples": counts,
        "lmEvalVersion": version("lm_eval"),
        "startedAtUtc": started.isoformat(timespec="seconds"),
        "wallSeconds": round(time.monotonic() - t0, 1),
    }
    (out / "eval.json").write_text(json.dumps(meta, indent=2))
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
