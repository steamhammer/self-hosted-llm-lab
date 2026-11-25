#!/usr/bin/env python3
"""Minimal RunPod REST v2 client (standard library only), for machines without runpodctl.

    infra/runpod_api.py create  < spec.json   → {"id": ..., "costPerHr": ...}
    infra/runpod_api.py get     <pod-id>      → {"id", "name", "status", "costPerHr"}
    infra/runpod_api.py list                  → [{"id", "name", "status", "costPerHr"}, ...]
    infra/runpod_api.py delete  <pod-id>

spec.json uses runpodctl-like names, mapped here to the v2 body (https://docs.runpod.io/api-reference-v2):
    {"name", "image", "gpu", "cloud", "disk", "minCudaVersion", "ports": [...], "env": {...}}
Needs RUNPOD_API_KEY. Prints only ids, names, status and price: never the pod's environment.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

API = os.environ.get("RUNPOD_API_URL", "https://api.runpod.io/v2")


def call(method: str, path: str, body: dict | None = None) -> dict | list | None:
    key = os.environ.get("RUNPOD_API_KEY")
    if not key:
        sys.exit("RUNPOD_API_KEY is not set")
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {key}", "content-type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read()
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:500]
        sys.exit(f"RunPod API {method} {path}: HTTP {err.code}: {detail}")
    except urllib.error.URLError as err:
        sys.exit(f"RunPod API {method} {path}: {err.reason}")
    return json.loads(raw) if raw else None


def summary(pod: dict) -> dict:
    cost = pod.get("cost", pod.get("costPerHr"))
    return {
        "id": pod.get("id"),
        "name": pod.get("name"),
        "status": pod.get("status"),
        "costPerHr": cost,
    }


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    if cmd == "create":
        spec = json.load(sys.stdin)
        gpu = {"id": spec["gpu"], "count": 1}
        if spec.get("minCudaVersion"):
            gpu["minCudaVersion"] = spec["minCudaVersion"]
        body = {
            "name": spec["name"],
            "image": spec["image"],
            "cloud": spec.get("cloud", "SECURE"),
            "gpu": gpu,
            "disk": int(spec.get("disk", 40)),
            "ports": spec.get("ports", []),
            "env": spec.get("env", {}),
        }
        print(json.dumps(summary(call("POST", "/pods", body) or {})))
    elif cmd == "get":
        print(json.dumps(summary(call("GET", f"/pods/{sys.argv[2]}") or {})))
    elif cmd == "list":
        out, cursor = [], None
        while True:
            page = call("GET", "/pods" + (f"?cursor={cursor}" if cursor else "")) or {}
            pods = page.get("pods", page if isinstance(page, list) else [])
            out += [summary(p) for p in pods]
            pag = page.get("pagination", {}) if isinstance(page, dict) else {}
            if not pag.get("hasNextPage"):
                break
            cursor = pag.get("nextCursor")
        print(json.dumps(out))
    elif cmd == "delete":
        call("DELETE", f"/pods/{sys.argv[2]}")
        print(json.dumps({"deleted": sys.argv[2]}))
    else:
        sys.exit(f"unknown command {cmd}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
