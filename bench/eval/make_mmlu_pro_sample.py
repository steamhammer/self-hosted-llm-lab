#!/usr/bin/env python3
"""Draws the fixed MMLU-Pro sample once: 100 random questions per subject, seed 2026.

  python bench/eval/make_mmlu_pro_sample.py      # needs huggingface.co; writes the JSON below

The indices point into the docs of lm-eval's mmlu_pro_<subject> subtasks, which is what
simple_evaluate(samples=...) takes. Question ids are stored next to them so the choice can be
checked against the dataset itself. The file is committed and never regenerated.
"""

from __future__ import annotations

import json
import random
from importlib.metadata import version
from pathlib import Path

OUT = Path(__file__).resolve().parent / "mmlu_pro_sample.json"
PER_SUBJECT = 100
SEED = 2026
# The 14 subtasks of lm-eval's "mmlu_pro" group (not mmlu_pro_llama_* or mmlu_pro_plus_*).
SUBJECTS = [
    "biology",
    "business",
    "chemistry",
    "computer_science",
    "economics",
    "engineering",
    "health",
    "history",
    "law",
    "math",
    "other",
    "philosophy",
    "physics",
    "psychology",
]


def main() -> None:
    from lm_eval.tasks import TaskManager, get_task_dict

    tm = TaskManager()
    subtasks = [f"mmlu_pro_{s}" for s in SUBJECTS]
    tasks = get_task_dict(subtasks, tm)
    indices, qids, sizes = {}, {}, {}
    for name in subtasks:
        docs = list(tasks[name].test_docs())
        picked = sorted(random.Random(f"{SEED}:{name}").sample(range(len(docs)), PER_SUBJECT))
        indices[name] = picked
        qids[name] = [docs[i]["question_id"] for i in picked]
        sizes[name] = len(docs)
    OUT.write_text(
        json.dumps(
            {
                "seed": SEED,
                "perSubject": PER_SUBJECT,
                "dataset": "TIGER-Lab/MMLU-Pro (test split)",
                "lmEvalVersion": version("lm_eval"),
                "subjectSizes": sizes,
                "indices": indices,
                "questionIds": qids,
            },
            indent=1,
        )
    )
    print(f"{OUT}: {len(indices)} subjects, {sum(len(v) for v in indices.values())} questions")


if __name__ == "__main__":
    main()
