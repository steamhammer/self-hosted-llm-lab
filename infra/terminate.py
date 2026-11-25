#!/usr/bin/env python3
"""Deletes the machine this script runs on. Standard library only; called by bootstrap.sh.

RunPod: `runpodctl` if present, else the REST API with the pod-scoped RUNPOD_API_KEY that RunPod
        injects together with RUNPOD_POD_ID.
Vast.ai: REST DELETE /api/v0/instances/{CONTAINER_ID}/ with the per-instance CONTAINER_API_KEY
        (it can only start, stop or destroy this one instance).
Anything else: prints a message and exits 1 (e.g. a laptop test run).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request


def _request(method: str, url: str, key: str, body: dict | None = None) -> bool:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {key}", "content-type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        payload = res.read()
        if body is not None and payload and json.loads(payload).get("errors"):
            raise RuntimeError(json.loads(payload)["errors"])
        return 200 <= res.status < 300


def runpod(pod_id: str) -> bool:
    if shutil.which("runpodctl"):
        for cmd in (["runpodctl", "pod", "delete", pod_id], ["runpodctl", "remove", "pod", pod_id]):
            if subprocess.run(cmd, check=False).returncode == 0:
                return True
    key = os.environ.get("RUNPOD_API_KEY")
    if not key:
        print("terminate: RUNPOD_API_KEY not set", file=sys.stderr)
        return False
    # REST v2 (https://docs.runpod.io/api-reference-v2/pods/terminate-a-pod), then the older
    # REST v1 and GraphQL endpoints in case the pod-scoped key is not accepted by the newer one.
    attempts = (
        ("DELETE", f"https://api.runpod.io/v2/pods/{pod_id}", None),
        ("DELETE", f"https://rest.runpod.io/v1/pods/{pod_id}", None),
        (
            "POST",
            "https://api.runpod.io/graphql",
            {"query": f'mutation {{ podTerminate(input: {{podId: "{pod_id}"}}) }}'},
        ),
    )
    for method, url, body in attempts:
        try:
            if _request(method, url, key, body):
                return True
        except Exception as err:  # noqa: BLE001 — fall through to the next endpoint
            print(f"terminate: {method} {url} failed: {err}", file=sys.stderr)
    return False


def vast(instance_id: str) -> bool:
    key = os.environ.get("CONTAINER_API_KEY")
    if not key:
        print("terminate: CONTAINER_API_KEY not set", file=sys.stderr)
        return False
    req = urllib.request.Request(
        f"https://console.vast.ai/api/v0/instances/{instance_id}/",
        headers={"Authorization": f"Bearer {key}"},
        method="DELETE",
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return 200 <= res.status < 300


def main() -> int:
    pod_id, vast_id = os.environ.get("RUNPOD_POD_ID"), os.environ.get("CONTAINER_ID")
    if not pod_id and not vast_id:
        print("terminate: no RunPod or Vast.ai environment detected; nothing to delete")
        return 1
    for attempt in range(1, 6):
        try:
            if (runpod(pod_id) if pod_id else vast(vast_id)) is True:
                print(
                    f"terminate: deletion requested for {'runpod ' + pod_id if pod_id else 'vast ' + vast_id}"
                )
                return 0
        except Exception as err:  # noqa: BLE001 — keep trying, report everything
            print(f"terminate: attempt {attempt} failed: {err}", file=sys.stderr)
        time.sleep(10 * attempt)
    return 1


if __name__ == "__main__":
    sys.exit(main())
