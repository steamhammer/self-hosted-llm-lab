#!/usr/bin/env python3
"""Shows what a GPU host has to download for the lab image: compressed size per layer.

    infra/image_info.py [ghcr.io/<owner>/llm-lab:<tag>]    (default: $LAB_IMAGE or :main)

Uses the anonymous GHCR token, so it also tells whether the package is public. Standard library
plus curl (curl uses the macOS trust store, which some Python builds do not).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

ACCEPT = (
    "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, "
    "application/vnd.docker.distribution.manifest.list.v2+json, "
    "application/vnd.docker.distribution.manifest.v2+json"
)


def curl_json(url: str, token: str | None = None) -> dict:
    cmd = ["curl", "-sS", "-H", f"Accept: {ACCEPT}", url]
    if token:
        cmd[2:2] = ["-H", f"Authorization: Bearer {token}"]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    try:
        return json.loads(out)
    except ValueError:
        sys.exit(f"unexpected answer from {url}: {out[:200]!r}")


def main() -> int:
    image = (
        (sys.argv[1] if len(sys.argv) > 1 else "")
        or os.environ.get("LAB_IMAGE")
        or "ghcr.io/steamhammer/llm-lab:main"
    )
    if not image.startswith("ghcr.io/"):
        sys.exit("only ghcr.io images are supported")
    name, _, tag = image.removeprefix("ghcr.io/").partition(":")
    tag = tag or "latest"

    token = curl_json(f"https://ghcr.io/token?scope=repository:{name}:pull").get("token")
    if not token:
        sys.exit("no anonymous token: the package is private or does not exist")
    base = f"https://ghcr.io/v2/{name}/manifests/"
    manifest = curl_json(base + tag, token)
    if "errors" in manifest:
        sys.exit(f"{image}: {manifest['errors']}")
    if "manifests" in manifest:  # multi-platform index: take linux/amd64
        digest = next(
            (
                m["digest"]
                for m in manifest["manifests"]
                if m.get("platform", {}).get("architecture") == "amd64"
            ),
            None,
        )
        if not digest:
            sys.exit("no linux/amd64 image in the index")
        manifest = curl_json(base + digest, token)

    layers = manifest.get("layers", [])
    total = sum(layer["size"] for layer in layers)
    print(f"{image}: public, {len(layers)} layers, {total / 1e9:.2f} GB compressed")
    for layer in sorted(layers, key=lambda l: -l["size"])[:5]:
        print(f"  {layer['size'] / 1e9:6.2f} GB  {layer['digest'][:19]}")
    for mbit in (300, 1000):
        print(
            f"  download at {mbit} Mbit/s: ~{total * 8 / (mbit * 1e6) / 60:.0f} min (plus unpacking)"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
