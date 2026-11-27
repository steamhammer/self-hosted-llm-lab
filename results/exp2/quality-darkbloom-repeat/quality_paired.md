# Paired against 2026-11-27_api_darkbloom-fp4_9b

| run | vs | set | n_paired | diff_pp | ci95_pp | lost | gained | mcnemar_p | same_answer | same_text | median_divergence_char | prompt_mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-27_api_darkbloom-fp4_9b_repeat | 2026-11-27_api_darkbloom-fp4_9b | gsm8k_cot_llama | 1319 | 0.2 | -0.3 to +0.6 | 4 | 6 | 0.7539 | 98% | 86% | 278 | 0 |
| 2026-11-27_api_darkbloom-fp4_9b_repeat | 2026-11-27_api_darkbloom-fp4_9b | ifeval | 541 | 0.7 | -0.7 to +2.4 | 7 | 11 | 0.4807 | 46% | 46% | 251 | 0 |
| 2026-11-27_api_darkbloom-fp4_9b_repeat | 2026-11-27_api_darkbloom-fp4_9b | mmlu_pro | 1400 | -0.1 | -1.1 to +0.8 | 25 | 23 | 0.8854 | 94% | 60% | 650 | 0 |
| 2026-11-27_api_darkbloom-fp4_9b_repeat | 2026-11-27_api_darkbloom-fp4_9b | mmlu_pro:quantitative | 400 | -1.5 | -3.8 to +0.8 | 13 | 7 | 0.2632 | 93% | 48% | 824 | 0 |
| 2026-11-27_api_darkbloom-fp4_9b_repeat | 2026-11-27_api_darkbloom-fp4_9b | mmlu_pro:knowledge | 1000 | 0.4 | -0.6 to +1.5 | 12 | 16 | 0.5716 | 95% | 64% | 543 | 0 |
