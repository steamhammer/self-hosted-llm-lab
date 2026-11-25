#!/usr/bin/env python3
"""Environment fingerprint for a benchmark run (methodology §2). Standard library only.

Usage: python3 bench/collect_env.py --out <run_dir>/env.json [--server-url http://127.0.0.1:8000]

Reads from the environment (all optional): PROVIDER, REGION, GPU_PRICE_PER_HOUR_USD,
VLLM_IMAGE (tag or digest), VLLM_CONFIG (path to the vLLM config used).
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

GPU_FIELDS = [
    "name",
    "uuid",
    "memory.total",
    "driver_version",
    "power.limit",
    "pcie.link.gen.current",
    "pcie.link.width.current",
    "clocks.max.sm",
]


def run(cmd: list[str]) -> str | None:
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=20, check=True
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def gpus() -> dict | None:
    if not shutil.which("nvidia-smi"):
        return None
    out = run(
        ["nvidia-smi", f"--query-gpu={','.join(GPU_FIELDS)}", "--format=csv,noheader,nounits"]
    )
    header = run(["nvidia-smi"]) or ""
    cuda = re.search(r"CUDA Version:\s*([\d.]+)", header)
    devices = []
    for line in (out or "").splitlines():
        values = [v.strip() for v in line.split(",")]
        devices.append(dict(zip(GPU_FIELDS, values)))
    return {"cuda": cuda.group(1) if cuda else None, "devices": devices}


def cpu_and_memory() -> dict:
    info: dict = {"cores": os.cpu_count(), "machine": platform.machine()}
    if platform.system() == "Linux":
        lscpu = run(["lscpu"]) or ""
        m = re.search(r"Model name:\s*(.+)", lscpu)
        info["model"] = m.group(1).strip() if m else None
        meminfo = Path("/proc/meminfo")
        if meminfo.exists():
            m = re.search(r"MemTotal:\s*(\d+) kB", meminfo.read_text())
            info["memory_gb"] = round(int(m.group(1)) / 1024 / 1024, 1) if m else None
    elif platform.system() == "Darwin":
        info["model"] = run(["sysctl", "-n", "machdep.cpu.brand_string"])
        mem = run(["sysctl", "-n", "hw.memsize"])
        info["memory_gb"] = round(int(mem) / 1024**3, 1) if mem else None
    return info


def http_json(url: str) -> dict | None:
    try:
        with urllib.request.urlopen(url, timeout=5) as res:
            return json.loads(res.read())
    except (OSError, ValueError):
        return None


def server(url: str) -> dict:
    base = url.rstrip("/")
    models = http_json(f"{base}/v1/models") or {}
    return {
        "url": base,
        "version": http_json(f"{base}/version"),  # vLLM
        "props": (http_json(f"{base}/props") or {}).get("build_info"),  # llama.cpp
        "models": [
            {k: m.get(k) for k in ("id", "root", "max_model_len") if k in m}
            for m in models.get("data", [])
        ],
    }


def methodology_version() -> str | None:
    doc = REPO / "docs" / "methodology.md"
    if not doc.exists():
        return None
    m = re.search(r"\*\*Version:\*\*\s*([^\s·]+)", doc.read_text())
    return m.group(1) if m else None


def git() -> dict:
    # Inside the lab image there is no .git: the image build records the commit in LAB_GIT_SHA.
    if os.environ.get("LAB_GIT_SHA"):
        return {"commit": os.environ["LAB_GIT_SHA"], "dirty": None, "source": "image"}
    sha = run(["git", "-C", str(REPO), "rev-parse", "HEAD"])
    dirty = run(["git", "-C", str(REPO), "status", "--porcelain"])
    return {"commit": sha, "dirty": bool(dirty) if dirty is not None else None}


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--out", required=True)
    p.add_argument("--server-url", default=os.environ.get("SERVER_URL", "http://127.0.0.1:8000"))
    args = p.parse_args()

    price = os.environ.get("GPU_PRICE_PER_HOUR_USD")
    env = {
        "collectedAt": datetime.now(UTC).isoformat(),
        "host": platform.node(),
        "os": f"{platform.system()} {platform.release()}",
        "provider": os.environ.get("PROVIDER") or None,
        "region": os.environ.get("REGION") or None,
        "pricePerHourUsd": float(price) if price else None,
        "gpu": gpus(),
        "cpu": cpu_and_memory(),
        "server": server(args.server_url),
        "vllmImage": os.environ.get("VLLM_IMAGE") or None,
        "vllmConfig": os.environ.get("VLLM_CONFIG") or None,
        "labImage": os.environ.get("LAB_IMAGE") or None,
        "session": os.environ.get("LAB_SESSION") or None,
        "methodologyVersion": methodology_version(),
        "repo": git(),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(env, indent=2) + "\n")
    print(f"env → {out}")


if __name__ == "__main__":
    main()
