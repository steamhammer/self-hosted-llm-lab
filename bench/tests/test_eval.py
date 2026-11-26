"""bench/eval against a fake OpenAI-compatible server with an offline task (no network)."""

from __future__ import annotations

import gzip
import json
import shutil
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar

import pytest

lm_eval = pytest.importorskip("lm_eval")

EVAL = Path(__file__).resolve().parents[1] / "eval"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "eval_task"
sys.path.insert(0, str(EVAL))


class FakeRouter(BaseHTTPRequestHandler):
    seen: ClassVar[list[dict]] = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        FakeRouter.seen.append({"auth": self.headers.get("authorization"), "body": body})
        question = body["messages"][-1]["content"]
        answer = {"2+4?": "The final answer is 6", "3+4?": "It is 8"}.get(question, "2")
        payload = {
            "id": "gen-1",
            "provider": "FakeInfra",
            "choices": [{"index": 0, "message": {"content": answer}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3, "cost": 0.0001},
        }
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


@pytest.fixture()
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeRouter)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    FakeRouter.seen = []
    yield f"http://127.0.0.1:{srv.server_address[1]}/v1/chat/completions"
    srv.shutdown()


def test_run_eval_end_to_end(server, tmp_path, monkeypatch):
    import run_eval
    from lm_eval.tasks import TaskManager

    task_dir = tmp_path / "task"
    shutil.copytree(FIXTURE, task_dir)
    monkeypatch.chdir(task_dir)  # the task's data_files path is relative
    real_tm = TaskManager
    monkeypatch.setattr(
        "lm_eval.evaluator.TaskManager", lambda *a, **k: real_tm(include_path=str(task_dir))
    )
    monkeypatch.setenv("FAKE_KEY", "sk-test")

    out = tmp_path / "out"
    code = run_eval.main(
        [
            "--url", server, "--model", "qwen/qwen3.5-27b", "--label", "t", "--out", str(out),
            "--tasks", "lab_toy", "--concurrency", "2", "--key-env", "FAKE_KEY",
            "--extra-body", '{"provider":{"only":["fake"]},"reasoning":{"effort":"none"}}',
        ]
    )  # fmt: skip
    assert code == 0

    sent = FakeRouter.seen
    assert len(sent) == 3
    assert all(s["auth"] == "Bearer sk-test" for s in sent)
    assert all(s["body"]["provider"] == {"only": ["fake"]} for s in sent)
    assert all(s["body"]["reasoning"] == {"effort": "none"} for s in sent)
    assert all(s["body"]["temperature"] == 0 for s in sent)

    scores = json.loads((out / "results.json").read_text())["results"]["lab_toy"]
    assert scores["exact_match,flexible-extract"] == pytest.approx(2 / 3)
    with gzip.open(out / "samples" / "lab_toy.jsonl.gz", "rt") as fh:
        rows = [json.loads(line) for line in fh]
    assert sorted(r["doc_id"] for r in rows) == [0, 1, 2]
    usage = [json.loads(line) for line in (out / "usage.jsonl").read_text().splitlines()]
    assert len(usage) == 3 and all(u["provider"] == "FakeInfra" for u in usage)
    meta = json.loads((out / "eval.json").read_text())
    assert meta["keyEnv"] == "FAKE_KEY" and "sk-test" not in (out / "eval.json").read_text()
