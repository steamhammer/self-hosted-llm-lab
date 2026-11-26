"""lm-evaluation-harness model "lab-chat": local-chat-completions plus what experiment 2 needs.

- Merges a fixed JSON object into every request body (LAB_EVAL_EXTRA_BODY): OpenRouter provider
  pinning and `reasoning: {effort: none}` for hosted APIs, nothing for our own vLLM, whose config
  already turns thinking off.
- Sends a bearer key read from the env var named by LAB_EVAL_KEY_ENV (never logged).
- Appends each response's usage, cost and serving provider to LAB_EVAL_USAGE_LOG (JSONL), so the
  quality run also tells us what it cost and whether reasoning was really off.

Importing this module registers the model; bench/eval/run_eval.py does that before evaluating.
"""

from __future__ import annotations

import json
import os
from functools import cached_property
from typing import Any

from lm_eval.api.registry import register_model
from lm_eval.models.openai_completions import LocalChatCompletion


def deep_merge(base: dict, extra: dict) -> dict:
    out = dict(base)
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def usage_row(response: dict) -> dict:
    usage = response.get("usage") or {}
    details = usage.get("completion_tokens_details") or {}
    choice = (response.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    reasoning = message.get("reasoning_content") or message.get("reasoning") or ""
    return {
        "id": response.get("id"),
        "provider": response.get("provider"),
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        "reasoning_tokens": details.get("reasoning_tokens"),
        "reasoning_chars": len(reasoning) if isinstance(reasoning, str) else None,
        "cost": usage.get("cost"),
        "finish_reason": choice.get("finish_reason"),
    }


@register_model("lab-chat")
class LabChat(LocalChatCompletion):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        raw = os.environ.get("LAB_EVAL_EXTRA_BODY", "")
        self.extra_body: dict = json.loads(raw) if raw else {}
        if not isinstance(self.extra_body, dict):
            raise TypeError("LAB_EVAL_EXTRA_BODY must be a JSON object")
        self.usage_log = os.environ.get("LAB_EVAL_USAGE_LOG")

    @cached_property
    def header(self) -> dict:
        env = os.environ.get("LAB_EVAL_KEY_ENV")
        if not env:
            return {}
        key = os.environ.get(env)
        if not key:
            raise RuntimeError(f"{env} is not set (LAB_EVAL_KEY_ENV)")
        return {"Authorization": f"Bearer {key}"}

    def _create_payload(self, messages, generate=False, gen_kwargs=None, seed=1234, eos=None, **kw):
        payload = super()._create_payload(
            messages, generate=generate, gen_kwargs=gen_kwargs, seed=seed, eos=eos, **kw
        )
        return deep_merge(payload, self.extra_body)

    def parse_generations(self, outputs, **kwargs) -> list[str]:
        if self.usage_log:
            rows = outputs if isinstance(outputs, list) else [outputs]
            with open(self.usage_log, "a") as fh:
                for out in rows:
                    if isinstance(out, dict):
                        fh.write(json.dumps(usage_row(out)) + "\n")
        return super().parse_generations(outputs, **kwargs)
