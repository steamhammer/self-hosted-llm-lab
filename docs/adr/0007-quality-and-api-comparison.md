# 0007. Experiment 2: hosted APIs through OpenRouter, quality with lm-evaluation-harness

- Status: Accepted
- Date: 2026-11-26

## Context

Experiment 1 gave the price of a token on our own GPUs and said nothing about two things a product
team asks next: what the same model costs behind an API, and what FP8 or Int4 weights cost in
answer quality. Both need a comparison that is fair across very different serving setups:

- APIs bill input and output separately and per token; our cost is per hour.
- A model name on an API does not say how it is served. OpenRouter's endpoint list does state a
  quantization for some providers (for Qwen3.5-27B: one BF16, several FP8, one undisclosed), which
  turns "is the API quietly quantized?" into something we can test.
- Quality numbers from model cards or leaderboards come from other prompts, other extraction rules
  and other tool versions, so they cannot be compared with our own runs.

## Decision

**APIs.** All hosted endpoints go through [OpenRouter](https://openrouter.ai): one key, one bill,
one response format, and [provider routing](https://openrouter.ai/docs/features/provider-routing)
that can pin a single provider with fallbacks off. Endpoints are picked to cover the quantizations
on offer (BF16, FP8, FP4, undisclosed) plus the cheapest, three per model, and written with their
prices into a dated file, [`bench/api/providers.yaml`](../../bench/api/providers.yaml). One closed
model of the 27B price class is added as a reference. Latency is measured with our own load
generator, extended for hosted APIs (auth from an environment variable, a configurable path,
billed cost, provider and reasoning fields per record), so API and self-hosted numbers come from
the same client.

**Quality.** [lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) 0.4.13,
pinned, through its chat-completions client, with three rule-scored sets: GSM8K
(`gsm8k_cot_llama`, all 1,319), MMLU-Pro (100 questions per subject drawn once with a fixed seed
and committed) and IFEval (all 541). A thin model class (`lab-chat`,
[`bench/eval/lab_lm.py`](../../bench/eval/lab_lm.py)) adds what the stock client lacks: a fixed
JSON merged into every request (provider pinning, reasoning off) and a log of tokens, cost and
provider per response. Every question's response is kept, so comparisons are paired.

**Analysis.** [`bench/analyze/exp2.py`](../../bench/analyze/exp2.py): break-even load U* from our
`capacity.csv` and the price file; API latency, errors and billed cost; accuracy with bootstrap
intervals and paired differences against our BF16 with McNemar's exact test.

## Alternatives considered

- **Calling each provider's own API.** More keys, more formats and more billing accounts for six
  endpoints, and no common way to pin a provider. One provider is still worth calling directly to
  see what the router adds; that is an add-on, not the base.
- **Our own prompts with an LLM judge as the main quality signal.** Closer to a product, but the
  judge adds its own bias and cost and needs its own validation. Kept as an optional step
  (methodology §11.3) for explaining a difference the rule-scored sets find.
- **Log-likelihood tasks (classic MMLU, HellaSwag).** Need token log-probabilities, which hosted
  chat APIs mostly do not return, so APIs and our server could not run the same tasks. Generative
  tasks also measure what an application actually receives.
- **Full MMLU-Pro (12,032 questions).** About 9× the cost and time for intervals that shrink only
  by a factor of three. 100 per subject keeps every subject, which the math-vs-knowledge split
  needs.
- **lm-eval's `--limit` instead of a sample file.** `--limit` takes the first N questions of each
  subject, which follow the dataset's source order. A seeded random sample written to git is
  reproducible and not tied to that order.

## Consequences

- API latency includes the internet round trip from the laptop, ours does not. Every comparison
  says so.
- Prices and quantizations on OpenRouter change; the snapshot date travels with every number, and
  the article gives the U* formula so readers can recompute with today's prices.
- An endpoint can change what it serves between our runs. Each record keeps the provider OpenRouter
  reports, and the three time-of-day runs would show a sudden change.
- Pinning lm-eval means its prompt templates and answer regexes are frozen for the experiment; an
  upgrade invalidates the comparison and needs all variants re-run.
- The MMLU-Pro sample is drawn once (`bench/eval/make_mmlu_pro_sample.py`) and committed before
  the first paid run; it is never regenerated.
