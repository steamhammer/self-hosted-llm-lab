# Paired against 2026-11-27_eval_rtx4090_qwen3.5-9b.24gb_155322

| run | vs | set | n_paired | diff_pp | ci95_pp | lost | gained | mcnemar_p | same_answer | same_text | median_divergence_char | prompt_mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-27_api_darkbloom-fp4_9b | 2026-11-27_eval_rtx4090_qwen3.5-9b.24gb_155322 | gsm8k_cot_llama | 1319 | -0.3 | -1.6 to +1.0 | 41 | 37 | 0.7343 | 93% | 1% | 36 | 0 |
| 2026-11-27_api_darkbloom-fp4_9b | 2026-11-27_eval_rtx4090_qwen3.5-9b.24gb_155322 | ifeval | 541 | -1.7 | -4.4 to +1.1 | 33 | 24 | 0.2892 | 2% | 2% | 16 | 0 |
| 2026-11-27_api_darkbloom-fp4_9b | 2026-11-27_eval_rtx4090_qwen3.5-9b.24gb_155322 | mmlu_pro | 1400 | -5.1 | -6.9 to -3.2 | 124 | 53 | 0.0 | 82% | 0% | 49 | 0 |
| 2026-11-27_api_darkbloom-fp4_9b | 2026-11-27_eval_rtx4090_qwen3.5-9b.24gb_155322 | mmlu_pro:quantitative | 400 | -8.2 | -11.8 to -4.8 | 42 | 9 | 0.0 | 85% | 0% | 50 | 0 |
| 2026-11-27_api_darkbloom-fp4_9b | 2026-11-27_eval_rtx4090_qwen3.5-9b.24gb_155322 | mmlu_pro:knowledge | 1000 | -3.8 | -6.0 to -1.6 | 82 | 44 | 0.0009 | 80% | 0% | 47 | 0 |
| 2026-11-27_api_together_9b | 2026-11-27_eval_rtx4090_qwen3.5-9b.24gb_155322 | gsm8k_cot_llama | 1319 | 0.2 | -0.7 to +1.0 | 14 | 16 | 0.8555 | 97% | 35% | 103 | 0 |
| 2026-11-27_api_together_9b | 2026-11-27_eval_rtx4090_qwen3.5-9b.24gb_155322 | ifeval | 541 | -1.1 | -3.3 to +1.1 | 21 | 15 | 0.405 | 11% | 11% | 92 | 0 |
| 2026-11-27_api_together_9b | 2026-11-27_eval_rtx4090_qwen3.5-9b.24gb_155322 | mmlu_pro | 1400 | -0.8 | -2.3 to +0.7 | 62 | 51 | 0.3469 | 87% | 4% | 163 | 0 |
| 2026-11-27_api_together_9b | 2026-11-27_eval_rtx4090_qwen3.5-9b.24gb_155322 | mmlu_pro:quantitative | 400 | -0.8 | -3.5 to +2.0 | 18 | 15 | 0.7283 | 89% | 4% | 172 | 0 |
| 2026-11-27_api_together_9b | 2026-11-27_eval_rtx4090_qwen3.5-9b.24gb_155322 | mmlu_pro:knowledge | 1000 | -0.8 | -2.5 to +1.0 | 44 | 36 | 0.434 | 86% | 3% | 161 | 0 |
