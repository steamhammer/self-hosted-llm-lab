# 0006. Pod automation: one image, one job per pod, self-deletion

- Status: Accepted
- Date: 2026-11-25

## Context

Every paid minute must produce data, and a forgotten pod is the most likely way to blow the
budget (ADR-0003: $20–50, hard cap ~$100). The pod has to start, measure, save the results and
disappear on its own, also when something fails halfway, and the same procedure has to work on
[RunPod](https://docs.runpod.io/pods/overview) and [Vast.ai](https://docs.vast.ai/instances).
Nothing from the laptop should be needed while the pod runs, and no secret may end up in a
public image or in git.

## Decision

- **One image.** `infra/image/Dockerfile` adds this repository, Node.js 26 and
  [rclone](https://rclone.org) to the official
  [`vllm/vllm-openai:v0.32.0-cu129`](https://hub.docker.com/r/vllm/vllm-openai/tags) image. The
  final stage is only `COPY` layers, so hosts that cache the vLLM image pull a few hundred MB.
  CI builds it on every relevant push to main and tags it with the commit SHA, which is also
  baked in as `LAB_GIT_SHA` and recorded in every `env.json`. The CUDA 12.9 variant is used
  because more rental hosts have a driver for it than for CUDA 13.0.
- **One job per pod.** The image `ENTRYPOINT` is `infra/bootstrap.sh`, which runs one job from
  `infra/jobs/` (`rehearsal` or `gpu-session`) chosen by the `JOB` variable. vLLM is started from
  a config file in `serving/configs/` (`vllm serve --config`), so the exact server settings are in
  git and copied into each run directory.
- **Results to object storage.** The pod uploads its session folder to
  [Cloudflare R2](https://developers.cloudflare.com/r2/) every 5 minutes and once more at the end,
  with a token scoped to one bucket. `infra/fetch.sh` downloads it on the laptop and files the
  runs into `results/raw/` (measurements) or `results/local/` (rehearsals).
- **Self-deletion.** After the job (success or failure) the pod deletes itself through the
  provider API with the credentials each provider injects into its own containers: RunPod's
  pod-scoped `RUNPOD_API_KEY` with `RUNPOD_POD_ID`, Vast.ai's per-instance `CONTAINER_API_KEY`
  with `CONTAINER_ID` ([Vast docs](https://docs.vast.ai/guides/instances/docker-environment)).
  It deletes rather than stops: a stopped instance still bills for its disk.
- **Layered safety.** A watchdog sends TERM at `MAX_RUNTIME_MIN` (default 60) and deletes the
  machine itself if cleanup does not finish 10 minutes later. A restarted container (RunPod
  restarts exited ones) finds a "session finished" marker and deletes the machine instead of
  running the job again. Preflight checks (job exists, R2 writable) fail in seconds, before the
  model download. The launchers print the worst-case cost (`price × cap`) before creating anything.
- **Rehearsal first.** Before any measurement on a new GPU type or image, `JOB=rehearsal` runs the
  whole pipeline on `Qwen3.5-0.8B` on the cheapest 24 GB card (~10 minutes, a few cents).

## Alternatives considered

- **SSH in and run commands by hand.** Simple, but billing continues while you read output,
  steps get skipped, and a dropped connection or a late evening leaves the pod running.
- **Provider templates with an on-start script** (Vast `--onstart-cmd`, RunPod start command).
  The script lives in the provider's UI rather than in git, and the image's entrypoint is replaced
  by SSH/Jupyter launchers that differ between providers.
- **[SkyPilot](https://docs.skypilot.co) / [dstack](https://dstack.ai).** They solve
  provisioning and auto-stop across clouds, but add a control plane and abstractions to learn for
  a handful of short runs; the lab's point is to show the moving parts.
- **Network volume with cached weights.** Saves the model download on repeated runs, but volumes
  bill continuously and tie pods to one datacenter; downloads of 2–60 GB take minutes.
- **Results via `scp` or the provider's file browser.** Requires the laptop to be online at the end
  of the run and loses everything if the pod dies first.

## Consequences

- No SSH and no Jupyter on lab pods: debugging uses the provider's log view, the uploaded
  `logs/` folder, and `KEEP_ALIVE=1`, which keeps the pod (and vLLM on ports 8000/8080 behind the
  provider's proxy) until the watchdog cap.
- Secrets travel as pod environment variables and are visible in the provider's pod settings.
  Hence dedicated, revocable keys: an R2 token for one bucket, a read-only Hugging Face token.
- The image must be public on GHCR; it contains only code that is public anyway.
- Model download time is billed and not part of the measurements; `session.json` records the
  container's own runtime and an estimated cost so the overhead stays visible.
- The per-scenario restart hook (`infra/serve.sh restart`) costs a model reload per scenario
  (~1 minute with weights on disk) in exchange for no warm cache carried between scenarios.
