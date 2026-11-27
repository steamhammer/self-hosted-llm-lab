"""lm-evaluation-harness model "lab-chat": local-chat-completions plus what experiment 2 needs.

- Merges a fixed JSON object into every request body (LAB_EVAL_EXTRA_BODY): OpenRouter provider
  pinning and `reasoning: {effort: none}` for hosted APIs, nothing for our own vLLM, whose config
  already turns thinking off.
- Sends a bearer key read from the env var named by LAB_EVAL_KEY_ENV (never logged).
- Appends each response's usage, cost and serving provider to LAB_EVAL_USAGE_LOG (JSONL), so the
  quality run also tells us what it cost and whether reasoning was really off.
- Turns a provider's refusal (HTTP 400/403 after the retries) into a scored-as-wrong answer that
  is logged with `refused: true`, so one refused question does not abort the run.

Importing this module registers the model; bench/eval/run_eval.py does that before evaluating.
"""

from __future__ import annotations

import json
import os
from functools import cached_property
from typing import Any

import requests
from aiohttp import ClientResponseError
from lm_eval.api.registry import register_model
from lm_eval.models.openai_completions import LocalChatCompletion

# What an application would get back: the provider refused the request (Alibaba's content
# inspection answers 400/403 "data_inspection_failed" on some benchmark questions). Scored as a
# wrong answer and counted in usage.jsonl, instead of aborting the whole run.
REFUSED = "[refused by provider]"
REFUSAL_STATUS = {400, 403}


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

    def _log_refusal(self, status: int) -> None:
        # A 400/403 on every request means something else (a spent key, a bad request body),
        # not content refusals: stop instead of scoring a whole run as refused.
        self.refusals = getattr(self, "refusals", 0) + 1
        if self.refusals > int(os.environ.get("LAB_EVAL_MAX_REFUSALS", "100")):
            raise RuntimeError(f"more than {self.refusals - 1} refused requests: aborting")
        if self.usage_log:
            with open(self.usage_log, "a") as fh:
                fh.write(json.dumps({"refused": True, "status": status}) + "\n")

    def model_call(self, messages, *, generate=True, **kwargs):  # concurrency 1
        try:
            return super().model_call(messages, generate=generate, **kwargs)
        except requests.HTTPError as err:
            status = err.response.status_code if err.response is not None else 0
            if not generate or status not in REFUSAL_STATUS:
                raise
            self._log_refusal(status)
            return {"choices": [{"index": 0, "message": {"content": REFUSED}}], "refused": True}

    async def amodel_call(self, session, sem, messages, *, generate=True, **kwargs):
        try:
            return await super().amodel_call(session, sem, messages, generate=generate, **kwargs)
        except ClientResponseError as err:
            if not generate or err.status not in REFUSAL_STATUS:
                raise
            self._log_refusal(err.status)  # a few bytes, once per refusal
            return [REFUSED]

    def parse_generations(self, outputs, **kwargs) -> list[str]:
        if self.usage_log:
            rows = outputs if isinstance(outputs, list) else [outputs]
            with open(self.usage_log, "a") as fh:
                for out in rows:
                    if isinstance(out, dict) and not out.get("refused"):
                        fh.write(json.dumps(usage_row(out)) + "\n")
        return super().parse_generations(outputs, **kwargs)
