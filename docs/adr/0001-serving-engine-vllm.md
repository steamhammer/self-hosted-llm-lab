# 0001. Serving engine: vLLM

- Status: Accepted
- Date: 2026-11-24

## Context

The lab needs one serving engine that runs on five different NVIDIA GPUs (Ada, Ampere, Hopper),
handles many concurrent requests with continuous batching, supports INT4 / FP8 / BF16 weights,
exposes an OpenAI-compatible API and Prometheus metrics, and is what teams actually run in production.

## Decision

Use [vLLM](https://docs.vllm.ai), official Docker image [`vllm/vllm-openai`](https://hub.docker.com/r/vllm/vllm-openai),
**one pinned version for the whole campaign** (tag and digest recorded in every run).

Reasons:

- Continuous batching and paged KV cache — the behaviour under concurrency is the point of the lab.
- Same engine and config format on every GPU; no per-GPU build step.
- Per-model deployment recipes ([recipes.vllm.ai](https://recipes.vllm.ai)) for the chosen models.
- Built-in load generator (`vllm bench serve`) and an ecosystem benchmark tool ([GuideLLM](https://github.com/vllm-project/guidellm)).
- `/metrics` exposes KV-cache usage, queue length and preemptions — needed for the failure analysis.
- Also serves Whisper via `/v1/audio/transcriptions`, so the optional ASR part uses the same stack.

## Alternatives considered

| Option | Why not (for this lab) |
|---|---|
| [SGLang](https://github.com/sgl-project/sglang) | Comparable throughput and also OpenAI-compatible. Not chosen only to keep one engine; a good follow-up comparison. |
| [TensorRT-LLM](https://github.com/NVIDIA/TensorRT-LLM) | Often fastest on NVIDIA, but needs an engine build per model × GPU; too much setup for five GPU types on a $50 budget. |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) / [Ollama](https://ollama.com) | Excellent for single-user and local use; not built for high-concurrency batched serving. Used locally only, for development. |

## Consequences

- Results describe *vLLM version X*; any version change requires re-running the baseline.
- vLLM pre-allocates most GPU memory for KV cache (`--gpu-memory-utilization`), so "memory used"
  from `nvidia-smi` is not a useful metric; KV-cache usage from `/metrics` is.
- An SGLang comparison on the same configs is a natural extension.
