# Break-even load U*

API prices: bench/api/providers.yaml, snapshot 2026-11-26.

| run | model | scenario | ours_usd_per_1m | api | api_quantization | api_usd_per_1m | u_star | pays_off |
|---|---|---|---|---|---|---|---|---|
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | 0.404 | darkbloom-fp4_9b | fp4 | 0.29 | 1.391 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | 0.404 | deepinfra-bf16_9b | bf16 | 0.35 | 1.153 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | 0.404 | together_9b | unknown | 0.59 | 0.684 | above 68% load |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | 0.36 | darkbloom-fp4_9b | fp4 | 0.146 | 2.465 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | 0.36 | deepinfra-bf16_9b | bf16 | 0.17 | 2.117 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | 0.36 | together_9b | unknown | 0.284 | 1.267 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | 1.662 | darkbloom-fp4_9b | fp4 | 1.197 | 1.389 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | 1.662 | deepinfra-bf16_9b | bf16 | 1.483 | 1.12 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | 1.662 | together_9b | unknown | 2.517 | 0.66 | above 66% load |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | 3.436 | alibaba_27b | unknown | 1.95 | 1.762 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | 3.436 | deepinfra-fp8_27b | fp8 | 3.12 | 1.101 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | 3.436 | siliconflow-fp8_27b | fp8 | 2.5 | 1.375 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | longgen | 1.653 | alibaba_27b | unknown | 1.599 | 1.034 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | longgen | 1.653 | deepinfra-fp8_27b | fp8 | 2.652 | 0.623 | above 62% load |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | longgen | 1.653 | siliconflow-fp8_27b | fp8 | 2.05 | 0.806 | above 81% load |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | 13.723 | alibaba_27b | unknown | 4.16 | 3.299 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | 13.723 | deepinfra-fp8_27b | fp8 | 6.067 | 2.262 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | 13.723 | siliconflow-fp8_27b | fp8 | 5.333 | 2.573 | never |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | 0.231 | darkbloom-fp4_9b | fp4 | 0.29 | 0.797 | above 80% load |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | 0.231 | deepinfra-bf16_9b | bf16 | 0.35 | 0.66 | above 66% load |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | 0.231 | together_9b | unknown | 0.59 | 0.392 | above 39% load |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | 0.189 | darkbloom-fp4_9b | fp4 | 0.146 | 1.292 | never |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | 0.189 | deepinfra-bf16_9b | bf16 | 0.17 | 1.11 | never |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | 0.189 | together_9b | unknown | 0.284 | 0.664 | above 66% load |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | 0.662 | darkbloom-fp4_9b | fp4 | 1.197 | 0.553 | above 55% load |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | 0.662 | deepinfra-bf16_9b | bf16 | 1.483 | 0.446 | above 45% load |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | 0.662 | together_9b | unknown | 2.517 | 0.263 | above 26% load |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | chat | 3.078 | alibaba_27b | unknown | 1.95 | 1.579 | never |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | chat | 3.078 | deepinfra-fp8_27b | fp8 | 3.12 | 0.987 | above 99% load |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | chat | 3.078 | siliconflow-fp8_27b | fp8 | 2.5 | 1.231 | never |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | longgen | 1.507 | alibaba_27b | unknown | 1.599 | 0.942 | above 94% load |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | longgen | 1.507 | deepinfra-fp8_27b | fp8 | 2.652 | 0.568 | above 57% load |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | longgen | 1.507 | siliconflow-fp8_27b | fp8 | 2.05 | 0.735 | above 74% load |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | 12.534 | alibaba_27b | unknown | 4.16 | 3.013 | never |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | 12.534 | deepinfra-fp8_27b | fp8 | 6.067 | 2.066 | never |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | 12.534 | siliconflow-fp8_27b | fp8 | 5.333 | 2.35 | never |
| h100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | 7.768 | alibaba_27b | unknown | 4.16 | 1.867 | never |
| h100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | 7.768 | deepinfra-fp8_27b | fp8 | 6.067 | 1.28 | never |
| h100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | 7.768 | siliconflow-fp8_27b | fp8 | 5.333 | 1.456 | never |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | 3.028 | alibaba_27b | unknown | 4.16 | 0.728 | above 73% load |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | 3.028 | deepinfra-fp8_27b | fp8 | 6.067 | 0.499 | above 50% load |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | 3.028 | siliconflow-fp8_27b | fp8 | 5.333 | 0.568 | above 57% load |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | chat | 3.286 | alibaba_27b | unknown | 1.95 | 1.685 | never |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | chat | 3.286 | deepinfra-fp8_27b | fp8 | 3.12 | 1.053 | never |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | chat | 3.286 | siliconflow-fp8_27b | fp8 | 2.5 | 1.314 | never |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | longgen | 1.611 | alibaba_27b | unknown | 1.599 | 1.007 | never |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | longgen | 1.611 | deepinfra-fp8_27b | fp8 | 2.652 | 0.607 | above 61% load |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | longgen | 1.611 | siliconflow-fp8_27b | fp8 | 2.05 | 0.786 | above 79% load |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | rag | 12.678 | alibaba_27b | unknown | 4.16 | 3.048 | never |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | rag | 12.678 | deepinfra-fp8_27b | fp8 | 6.067 | 2.09 | never |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | rag | 12.678 | siliconflow-fp8_27b | fp8 | 5.333 | 2.377 | never |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | 1.292 | alibaba_27b | unknown | 1.95 | 0.662 | above 66% load |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | 1.292 | deepinfra-fp8_27b | fp8 | 3.12 | 0.414 | above 41% load |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | 1.292 | siliconflow-fp8_27b | fp8 | 2.5 | 0.517 | above 52% load |
