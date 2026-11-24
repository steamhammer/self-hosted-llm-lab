# 0002. Model family: Qwen3.5 (9B and 27B)

- Status: Accepted
- Date: 2026-11-24

## Context

The lab compares GPUs and quantizations. That comparison is only fair if the model stays the same
or at least comes from the same family. Two sizes are needed: one that fits a 24 GB card in BF16,
and one that needs quantization on 24–48 GB cards and fits 80 GB in BF16. The license must allow
publishing results and configs.

## Decision

- **Small:** [Qwen/Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B), BF16 — RTX 4090, L4.
- **Medium:** [Qwen/Qwen3.5-27B](https://huggingface.co/Qwen/Qwen3.5-27B) — INT4 (AWQ), FP8
  ([official FP8 checkpoint](https://recipes.vllm.ai/Qwen/Qwen3.5-27B)) and BF16 — L40S, A100 80 GB, H100.
- **Optional:** Qwen3.5-35B-A3B (MoE) on H100, to show dense vs MoE behaviour.
- **Baseline:** one run of Llama 3.1 8B Instruct on RTX 4090 (see Consequences).

Reasons: Apache-2.0 license; two dense sizes matching our two memory tiers; vLLM recipes exist for both
([9B](https://recipes.vllm.ai/Qwen/Qwen3.5-9B), [27B](https://recipes.vllm.ai/Qwen/Qwen3.5-27B));
the 27B model in BF16 / FP8 / INT4 gives a three-way quantization comparison on a single A100 80 GB.

## Alternatives considered

| Option | Why not |
|---|---|
| Qwen3 8B / 32B | Previous generation; Qwen3.5 covers the same two tiers (9B / 27B) with current vLLM support. |
| Llama 3.x (8B / 70B) | Huge body of public benchmarks, but 70B does not fit our tiers; older; custom license. Kept as a one-off baseline. |
| Gemma, Mistral | License terms (Gemma) or no dense size matching both tiers. |

## Consequences

- Qwen3.5 uses **hybrid attention** (Gated DeltaNet + full attention): KV cache per token is smaller
  than in a classic transformer of the same size, so concurrency numbers are not directly comparable
  with published Llama-style benchmarks. The Llama 3.1 8B baseline anchors the results.
- The models are multimodal: image inputs are disabled to keep memory for KV cache.
- Native context is 262K tokens: `--max-model-len` is set explicitly per GPU (e.g. 32K on 24 GB).
- Thinking mode is disabled for benchmarks (see methodology §3.4).
- Community AWQ checkpoints vary; the exact repo and revision are recorded per run.
