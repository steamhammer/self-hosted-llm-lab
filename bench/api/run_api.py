#!/usr/bin/env python3
"""Latency and cost of hosted APIs: one loadgen run per endpoint in providers.yaml.

  OPENROUTER_API_KEY=... uv run --package bench python bench/api/run_api.py --daypart morning
  ... --only deepinfra-fp8_27b,alibaba_27b      # a subset
  ... --dry-run                                 # print the commands, send nothing

Every endpoint is pinned through OpenRouter's provider routing with fallbacks off, so a run
measures exactly one hosting. Results go to results/raw/<date>_api_<id>_<daypart>_<time>/ with
an env.json that records the provider, its declared quantization and the price snapshot.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
PROVIDERS = ROOT / "bench" / "api" / "providers.yaml"
PLAN = ROOT / "bench" / "plans" / "api.yaml"
DAYPARTS = ("morning", "day", "evening")


def load_endpoints(path: Path = PROVIDERS) -> tuple[str, list[dict]]:
    data = yaml.safe_load(path.read_text())
    endpoints = data["endpoints"]
    ids = [e["id"] for e in endpoints]
    if len(ids) != len(set(ids)):
        raise SystemExit(f"{path}: duplicate endpoint ids")
    return str(data["snapshot"]), endpoints


def routing(endpoint: dict) -> dict:
    """OpenRouter provider routing for one endpoint: that provider only, no fallback."""
    if not endpoint.get("provider"):
        return {}
    return {"provider": {"only": [endpoint["provider"]], "allow_fallbacks": False}}


def command(endpoint: dict, out: Path, plan: Path = PLAN) -> list[str]:
    return [
        "node",
        str(ROOT / "loadgen" / "src" / "cli.ts"),
        "matrix",
        "--plan",
        str(plan),
        "--model",
        endpoint["model"],
        "--label",
        out.name,
        "--out",
        str(out),
        "--extra-body",
        json.dumps(routing(endpoint)),
    ]


def env_record(endpoint: dict, snapshot: str, daypart: str) -> dict:
    return {
        "kind": "hosted-api",
        "router": "openrouter",
        "endpoint": endpoint,
        "priceSnapshot": snapshot,
        "daypart": daypart,
        "startedAtUtc": datetime.now(UTC).isoformat(timespec="seconds"),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--daypart", required=True, choices=DAYPARTS, help="US time of day of the run")
    ap.add_argument("--only", help="comma-separated endpoint ids")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--plan", type=Path, default=PLAN, help="for local tests against a mock")
    ap.add_argument("--out-root", type=Path, default=ROOT / "results" / "raw")
    args = ap.parse_args(argv)

    snapshot, endpoints = load_endpoints()
    if args.only:
        wanted = set(args.only.split(","))
        unknown = wanted - {e["id"] for e in endpoints}
        if unknown:
            raise SystemExit(f"unknown endpoint ids: {', '.join(sorted(unknown))}")
        endpoints = [e for e in endpoints if e["id"] in wanted]
    if not args.dry_run and not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit("OPENROUTER_API_KEY is not set")

    failed = []
    for ep in endpoints:
        now = datetime.now()
        label = f"api_{ep['id']}_{args.daypart}"
        out = args.out_root / f"{now:%Y-%m-%d}_{label}_{now:%H%M%S}"
        cmd = command(ep, out, args.plan)
        print(f"== {ep['id']} ({ep['model']} via {ep.get('provider') or 'default routing'})")
        if args.dry_run:
            print("   " + " ".join(cmd))
            continue
        out.mkdir(parents=True)
        (out / "env.json").write_text(json.dumps(env_record(ep, snapshot, args.daypart), indent=2))
        if subprocess.run(cmd, cwd=ROOT, check=False).returncode != 0:
            failed.append(ep["id"])
            continue
        subprocess.run(
            [sys.executable, str(ROOT / "bench" / "analyze" / "analyze.py"), "report", str(out)],
            cwd=ROOT,
            check=False,
        )
    if failed:
        print(f"failed: {', '.join(failed)}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
