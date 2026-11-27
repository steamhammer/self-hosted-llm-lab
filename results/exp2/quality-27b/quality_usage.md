# Tokens, cost and reasoning per eval run

| run | responses | refused | prompt_tokens | completion_tokens | billed_usd | reasoning_responses | truncated | providers |
|---|---|---|---|---|---|---|---|---|
| 2026-11-27_eval_h100-80gb_qwen3.5-27b.bf16_154949 | 3260 | 0 | 3692957 | 1275743 | 0.0 | 0 | 129 |  |
| 2026-11-27_eval_h100-80gb_qwen3.5-27b.fp8_160929 | 3260 | 0 | 3692957 | 1286081 | 0.0 | 0 | 135 |  |
| 2026-11-27_eval_h100-80gb_qwen3.5-27b.int4_163030 | 3260 | 0 | 3692957 | 1292723 | 0.0 | 0 | 137 |  |
| 2026-11-27_api_alibaba_27b | 3251 | 7 | 3685876 | 1258744 | 2.6748 | 0 | 110 | Alibaba |
| 2026-11-27_api_deepinfra-fp8_27b | 3259 | 0 | 3692916 | 1277722 | 4.2822 | 0 | 131 | DeepInfra |
| 2026-11-27_api_gemini-3.1-flash-lite_closed | 3260 | 0 | 3431216 | 754152 | 1.989 | 0 | 6 | Google AI Studio |
