# infra: running the lab on a rented GPU

One container start = one session: the pod starts vLLM, runs a job, uploads results to R2 and
deletes itself. Why it is built this way: [ADR-0006](../docs/adr/0006-pod-automation.md).

```
laptop                                   rented GPU (lab image)
──────                                   ──────────────────────────────────────────────
infra/runpod/up.sh ─┐                     bootstrap.sh
infra/vast/up.sh  ──┴─ create pod ─────▶   ├─ preflight: job exists, R2 writable
                                          ├─ watchdog: TERM at MAX_RUNTIME_MIN, hard delete +10 min
                                          ├─ jobs/<JOB>.sh
                                          │    ├─ serve.sh start   (vllm serve --config …)
                                          │    ├─ gateway.sh start (benchmark mode, :8080)
                                          │    └─ bench/run_matrix.sh … (restart hook per scenario)
                                          ├─ rclone → R2 every 5 min and at the end
                                          └─ terminate.py: delete this pod / instance
infra/fetch.sh ◀────── R2 ◀──────────────
  results/raw/<run>/      (measurements, tracked)
  results/local/<run>/    (rehearsals)
  results/sessions/<session>/session.json, logs/
```

## Files

| File | What |
|---|---|
| `image/Dockerfile` | Lab image: [`vllm/vllm-openai:v0.32.0-cu129`](https://hub.docker.com/r/vllm/vllm-openai/tags) + repo + Node.js 26 + [rclone](https://rclone.org) |
| `bootstrap.sh` | Image entrypoint: session lifecycle, uploads, watchdog, self-deletion |
| `jobs/rehearsal.sh` | ~10 min pipeline check on `Qwen3.5-0.8B` |
| `jobs/gpu-session.sh` | Full plan for each config in `CONFIGS` |
| `serve.sh` | Start / stop / restart vLLM and wait for `/health`; the plans' `beforeScenario` hook |
| `gateway.sh` | Gateway next to vLLM with admission limits and TTFT timeout pushed out of the way |
| `terminate.py` | Deletes the current RunPod pod or Vast.ai instance via the provider API |
| `runpod/up.sh`, `vast/up.sh` | Launchers: build the pod environment from `.env`, print the worst-case cost |
| `fetch.sh` | Lists and downloads sessions from R2, files the runs, runs the analysis |
| `lib.sh` | Shared shell helpers |

## One-time setup

1. **R2 bucket and token.** In the Cloudflare dashboard create the bucket `llm-lab-results`, then
   an R2 API token with *Object Read & Write* limited to that bucket
   ([R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/)). Put the account id, access
   key id and secret into `.env` (see `.env.example`).
2. **rclone on the Mac** for `fetch.sh`: `brew install rclone`
   ([install](https://rclone.org/install/)). No `rclone config` is needed: the remote is defined
   from the `R2_*` variables.
3. **Lab image.** Push to main; [`lab-image.yml`](../.github/workflows/lab-image.yml) builds
   `ghcr.io/<owner>/llm-lab:<sha>` and `:main`. Make the package public once: GitHub → your
   profile → Packages → `llm-lab` → Package settings → Change visibility
   ([GHCR docs](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)).
   Set `LAB_IMAGE` in `.env`; pin the SHA tag for measured runs.
4. **Provider CLIs**, already set up in phase 0:
   [`runpodctl`](https://docs.runpod.io/runpodctl/overview) and
   [`vastai`](https://docs.vast.ai/cli/get-started).

## Rehearsal (do this first)

On the cheapest 24 GB card, e.g. RTX 3090 or RTX A5000 (prices:
[RunPod](https://www.runpod.io/pricing), [Vast.ai](https://vast.ai/pricing)):

```bash
infra/vast/up.sh --gpu RTX_3090 --max-price 0.30 --max-min 30 --dry-run   # check offer and command
infra/vast/up.sh --gpu RTX_3090 --max-price 0.30 --max-min 30
# or
infra/runpod/up.sh --gpu "NVIDIA GeForce RTX 3090" --price 0.22 --max-min 30
```

GPU names: [RunPod GPU types](https://docs.runpod.io/references/gpu-types) (the "GPU ID"
column); for Vast, `vastai search offers 'num_gpus=1' -o dph` shows `gpu_name` values (spaces
become underscores).

Then, in 10–20 minutes (image pull and model download come first):

```bash
infra/fetch.sh            # sessions in the bucket
infra/fetch.sh latest     # download, file runs into results/local/, analyse
```

A good rehearsal has `"status": "succeeded"` in `results/sessions/<session>/session.json`, a
`smoke.txt` with tokens, two run folders (direct and through the gateway) with reports, and a
`crosscheck/` folder from `vllm bench serve`. Also check in the provider's console that the pod is
gone.

## Measurement session

```bash
infra/runpod/up.sh --gpu "NVIDIA GeForce RTX 4090" --price 0.34 \
  --job gpu-session --configs qwen3.5-9b.24gb --max-min 90
```

`--configs` takes several comma-separated names from `serving/configs/`; a failed config does not
stop the next one. Budget the cap as: pull + download (5–15 min) + ~1 min model load per scenario
+ the plan itself.

## When something goes wrong

- **Abort:** `runpodctl pod delete <id>` or `vastai destroy instance <id>` (delete, not stop:
  stopped instances still bill for disk).
- **Logs:** the provider's log view shows `bootstrap.log` live; the uploaded session has
  `logs/bootstrap.log`, `vllm.log`, `gateway.log`.
- **Look around on a live pod:** `--keep-alive` keeps it after the job until the cap; vLLM and the
  gateway stay reachable on ports 8000 and 8080 through the provider's proxy.
- **"cannot write to r2:…"** in the first seconds: token, bucket name or account id is wrong; the
  pod has already deleted itself.

## Testing without a GPU

`bootstrap.sh` runs on a laptop with the mock upstream instead of vLLM, a local folder instead of
R2 and a fake delete command:

```bash
JOB=rehearsal LAB_FAKE_VLLM=1 LAB_NO_SLEEP=1 LAB_WORK_ROOT=/tmp/lab \
RESULTS_REMOTE=/tmp/lab-remote TERMINATE_CMD='echo would delete' infra/bootstrap.sh
RESULTS_REMOTE=/tmp/lab-remote infra/fetch.sh latest
```

`MAX_RUNTIME_S=5` with a job that sleeps exercises the watchdog.
