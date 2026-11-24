#!/usr/bin/env python3
"""Builds bench/data/sharegpt.jsonl for the `sharegpt` scenario (methodology §3.2).

Download the source once (≈670 MB):
  hf download anon8231489123/ShareGPT_Vicuna_unfiltered ShareGPT_V3_unfiltered_cleaned_split.json \\
     --repo-type dataset --local-dir bench/data

Then:
  python3 bench/prepare_sharegpt.py bench/data/ShareGPT_V3_unfiltered_cleaned_split.json

Takes the first human turn of each conversation as the prompt and the length of the first model
answer as max_tokens (≈4 characters per token, clamped), like vLLM's own ShareGPT benchmark.
The output is a seeded sample, so every run uses the same prompts.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("source")
    p.add_argument("--out", default="bench/data/sharegpt.jsonl")
    p.add_argument("--n", type=int, default=2000)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--max-prompt-chars", type=int, default=16_000)
    p.add_argument("--max-output-tokens", type=int, default=1024)
    args = p.parse_args()

    rows = []
    for conv in json.loads(Path(args.source).read_text()):
        turns = conv.get("conversations") or []
        if len(turns) < 2 or turns[0].get("from") != "human" or turns[1].get("from") != "gpt":
            continue
        prompt, answer = turns[0].get("value", ""), turns[1].get("value", "")
        if len(prompt) < 16 or len(answer) < 16 or len(prompt) > args.max_prompt_chars:
            continue
        rows.append(
            {
                "prompt": prompt,
                "max_tokens": max(4, min(args.max_output_tokens, round(len(answer) / 4))),
            }
        )

    random.Random(args.seed).shuffle(rows)
    sample = rows[: args.n]
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in sample))
    print(f"{len(sample)} of {len(rows)} usable conversations → {out}")


if __name__ == "__main__":
    main()
