#!/usr/bin/env python3
"""Floor of hosted-API latency from this client: network + router + provider queue, no prefill.

  OPENROUTER_API_KEY=... uv run --package bench --group eval python bench/api/network_baseline.py

Two measurements, one request at a time over a kept-alive connection, as loadgen does:
  1. ping: GET /api/v1/key (tiny authenticated response) -> client <-> OpenRouter round trip
  2. floor TTFT: per endpoint in providers.yaml, a two-word prompt with max_tokens 8, streamed;
     time to the first content chunk, so prompt processing is negligible (max_tokens 1 leaves
     Gemini's content empty: its first token goes to the thought signature)

Writes results/raw/<date>_api_network-baseline_<time>/{requests.csv,summary.csv,env.json}.
"""

from __future__ import annotations

import csv
import json
import os
import statistics
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).resolve().parents[2]
BASE = "https://openrouter.ai/api/v1"
N_PING = 50
N_FLOOR = 30


def pct(values: list[float], q: float) -> float:
    s = sorted(values)
    return round(s[min(len(s) - 1, int(q * len(s)))], 1) if s else float("nan")


def floor_ttft(session: requests.Session, model: str, provider: str | None) -> tuple[float, str]:
    body = {
        "model": model,
        "messages": [{"role": "user", "content": "Say OK"}],
        "max_tokens": 8,
        "stream": True,
        "temperature": 0,
        "reasoning": {"effort": "none"},
    }
    if provider:
        body["provider"] = {"only": [provider], "allow_fallbacks": False}
    t0 = time.perf_counter()
    with session.post(f"{BASE}/chat/completions", json=body, stream=True, timeout=60) as r:
        if r.status_code != 200:
            return float("nan"), f"http_{r.status_code}"
        # iter_content(None) yields bytes as they arrive (iter_lines() would wait for 512 bytes).
        # The stream is read to the end even after the first token: leaving early closes the
        # connection, and the next request would pay a new TLS handshake (~300 ms here).
        buf, ttft = b"", None
        for data in r.iter_content(chunk_size=None):
            buf += data
            while ttft is None and b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.startswith(b"data: ") or line.strip() == b"data: [DONE]":
                    continue
                chunk = json.loads(line[6:])
                for ch in chunk.get("choices") or []:
                    if (ch.get("delta") or {}).get("content"):
                        ttft = (time.perf_counter() - t0) * 1000
    return (ttft, "") if ttft is not None else (float("nan"), "no_content")


def main() -> int:
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise SystemExit("OPENROUTER_API_KEY is not set")
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {key}", "X-Title": "self-hosted-llm-lab"})
    now = datetime.now()
    out = ROOT / "results" / "raw" / f"{now:%Y-%m-%d}_api_network-baseline_{now:%H%M%S}"
    out.mkdir(parents=True)
    rows = []

    session.get(f"{BASE}/key", timeout=30)  # open and warm the connection
    for i in range(N_PING):
        t0 = time.perf_counter()
        r = session.get(f"{BASE}/key", timeout=30)
        rows.append(
            {
                "kind": "ping",
                "endpoint": "openrouter",
                "i": i,
                "ms": round((time.perf_counter() - t0) * 1000, 1),
                "error": "" if r.ok else f"http_{r.status_code}",
            }
        )

    endpoints = yaml.safe_load((ROOT / "bench" / "api" / "providers.yaml").read_text())["endpoints"]
    for ep in endpoints:
        floor_ttft(session, ep["model"], ep.get("provider"))  # warm-up, not recorded
        for i in range(N_FLOOR):
            ms, err = floor_ttft(session, ep["model"], ep.get("provider"))
            rows.append(
                {
                    "kind": "floor_ttft",
                    "endpoint": ep["id"],
                    "i": i,
                    "ms": round(ms, 1),
                    "error": err,
                }
            )
        print(f"{ep['id']}: done", file=sys.stderr)

    with open(out / "requests.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    summary = []
    for kind, ep in dict.fromkeys((r["kind"], r["endpoint"]) for r in rows):
        ok = [r["ms"] for r in rows if r["kind"] == kind and r["endpoint"] == ep and not r["error"]]
        errs = sum(1 for r in rows if r["kind"] == kind and r["endpoint"] == ep and r["error"])
        summary.append(
            {
                "kind": kind,
                "endpoint": ep,
                "n": len(ok),
                "errors": errs,
                "p50_ms": round(statistics.median(ok), 1) if ok else "",
                "p95_ms": pct(ok, 0.95),
                "min_ms": round(min(ok), 1) if ok else "",
            }
        )
    with open(out / "summary.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(summary[0]))
        w.writeheader()
        w.writerows(summary)
    (out / "env.json").write_text(
        json.dumps(
            {
                "kind": "network-baseline",
                "client": "Claude cloud workspace behind its HTTPS egress proxy (same as the API runs)",
                "startedAtUtc": datetime.now(UTC).isoformat(timespec="seconds"),
                "nPing": N_PING,
                "nFloor": N_FLOOR,
            },
            indent=2,
        )
    )
    print(out)
    for s in summary:
        print(s)
    return 0


if __name__ == "__main__":
    sys.exit(main())
