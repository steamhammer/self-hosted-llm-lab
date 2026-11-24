# 0003. GPU matrix and providers

- Status: Accepted
- Date: 2026-11-24

## Context

LLM decoding is mostly limited by memory bandwidth, prefill by compute; quantization formats depend on
hardware support (FP8 tensor cores exist on Ada and Hopper, not on Ampere). The matrix should expose
these effects across a realistic price range, within a $20–50 budget (hard cap $100), using only paid
hours for measurement.

## Decision

| GPU | VRAM | Memory BW | Arch | FP8 in HW | Role |
|---|---|---|---|---|---|
| RTX 4090 | 24 GB | ~1.0 TB/s | Ada | yes | Baseline, bring-up, gateway overhead |
| L4 | 24 GB | ~0.3 TB/s | Ada | yes | Same memory, ~3× less bandwidth than 4090: decode is bandwidth-bound |
| L40S | 48 GB | ~0.86 TB/s | Ada | yes | 27B INT4 vs FP8; failure experiment |
| A100 80 GB | 80 GB | ~1.9–2.0 TB/s | Ampere | **no** | 27B BF16 vs FP8 (weight-only) vs INT4 |
| H100 80 GB | 80 GB | 2.0 (PCIe) – 3.35 (SXM) TB/s | Hopper | yes | Ceiling; MTP speculative decoding |

Single GPU only. The exact variant (SXM vs PCIe) is recorded per run, because bandwidth differs a lot.

Providers:

- [Vast.ai](https://vast.ai/pricing) — primary for RTX 4090, L4, A100 (lowest price; hosts vary,
  so filter by reliability and verified datacenter).
- [RunPod](https://www.runpod.io/pricing) — L40S and H100, and any re-run that needs a more predictable host.
- [Lambda](https://lambda.ai/pricing) — fallback only, if H100 is not available elsewhere.

## Alternatives considered

| Option | Why not |
|---|---|
| Hyperscalers (AWS/GCP/Azure) | 2–5× higher hourly price, quotas for GPU instances; no benefit for a benchmark. |
| Multi-GPU (tensor parallel) | Out of scope and budget; a possible follow-up for BF16 27B on 2× smaller cards. |
| RTX 5090 / B200 | Interesting, but the chosen set already covers three architectures and the budget. |

## Consequences

- Marketplace variance is handled by the environment fingerprint (methodology §2) and re-runs on another host for outliers.
- Each paid session runs a scripted matrix with auto-shutdown; manual exploration is limited to the first 30 minutes of the first session.
- Prepaid balances are topped up per session, so the provider balance is the hard spend limit.
