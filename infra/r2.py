#!/usr/bin/env python3
"""Minimal Cloudflare R2 (S3 API) client, standard library only, for machines without rclone.

    infra/r2.py dirs <prefix/>          list "folders" directly under prefix (one per line)
    infra/r2.py get  <prefix/> <dir>    download every object under prefix into dir
    infra/r2.py cat  <key>              print one object

Credentials from R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (R2_ENDPOINT
optional). Requests are signed with AWS Signature V4 (region "auto"):
https://developers.cloudflare.com/r2/api/s3/api/
"""

from __future__ import annotations

import datetime
import hashlib
import hmac
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"


def env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"{name} is not set")
    return value


ENDPOINT = (
    os.environ.get("R2_ENDPOINT") or f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com"
)
HOST = urllib.parse.urlparse(ENDPOINT).netloc
BUCKET = env("R2_BUCKET")


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def request(path: str, query: dict[str, str] | None = None) -> bytes:
    """Signed GET of /<bucket>/<path>?<query>."""
    now = datetime.datetime.now(datetime.timezone.utc)  # noqa: UP017 — runs on Python 3.10 too
    amz_date, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    uri = "/" + urllib.parse.quote(f"{BUCKET}/{path}" if path else BUCKET, safe="/-_.~")
    qs = "&".join(
        f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}"
        for k, v in sorted((query or {}).items())
    )
    payload = hashlib.sha256(b"").hexdigest()
    headers = {"host": HOST, "x-amz-content-sha256": payload, "x-amz-date": amz_date}
    signed = ";".join(sorted(headers))
    canonical = "\n".join(
        ["GET", uri, qs, "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)), signed, payload]
    )
    scope = f"{day}/auto/s3/aws4_request"
    to_sign = "\n".join(
        ["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()]
    )
    k = _sign(("AWS4" + env("R2_SECRET_ACCESS_KEY")).encode(), day)
    for part in ("auto", "s3", "aws4_request"):
        k = _sign(k, part)
    signature = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    auth = (
        f"AWS4-HMAC-SHA256 Credential={env('R2_ACCESS_KEY_ID')}/{scope}, "
        f"SignedHeaders={signed}, Signature={signature}"
    )
    req = urllib.request.Request(
        f"{ENDPOINT}{uri}" + (f"?{qs}" if qs else ""),
        headers={"x-amz-content-sha256": payload, "x-amz-date": amz_date, "Authorization": auth},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return res.read()
    except urllib.error.HTTPError as err:
        sys.exit(f"R2 GET {uri}: HTTP {err.code}: {err.read().decode(errors='replace')[:300]}")
    except urllib.error.URLError as err:
        sys.exit(f"R2 GET {uri}: {err.reason}")


def list_objects(prefix: str, delimiter: str | None = None):
    """Yields ("dir", prefix) and ("obj", key, size) entries, following continuation tokens."""
    token = None
    while True:
        query = {"list-type": "2", "prefix": prefix}
        if delimiter:
            query["delimiter"] = delimiter
        if token:
            query["continuation-token"] = token
        root = ET.fromstring(request("", query))
        for cp in root.findall(f"{NS}CommonPrefixes"):
            yield ("dir", cp.findtext(f"{NS}Prefix"))
        for obj in root.findall(f"{NS}Contents"):
            yield ("obj", obj.findtext(f"{NS}Key"), int(obj.findtext(f"{NS}Size") or 0))
        if root.findtext(f"{NS}IsTruncated") != "true":
            return
        token = root.findtext(f"{NS}NextContinuationToken")


def main() -> int:
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cmd, prefix = sys.argv[1], sys.argv[2]
    if cmd == "dirs":
        prefix = prefix if prefix.endswith("/") else prefix + "/"
        for entry in list_objects(prefix, "/"):
            if entry[0] == "dir":
                print(entry[1][len(prefix) :].rstrip("/"))
    elif cmd == "get":
        dest = sys.argv[3]
        prefix = prefix if prefix.endswith("/") else prefix + "/"
        count = 0
        for entry in list_objects(prefix):
            if entry[0] != "obj":
                continue
            rel = entry[1][len(prefix) :]
            if not rel or ".." in rel.split("/"):
                continue
            path = os.path.join(dest, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(request(entry[1]))
            count += 1
        print(f"{count} files → {dest}")
    elif cmd == "cat":
        sys.stdout.buffer.write(request(prefix))
    else:
        sys.exit(f"unknown command {cmd}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
