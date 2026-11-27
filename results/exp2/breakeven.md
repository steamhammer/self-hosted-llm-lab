# Break-even load U*

API prices: bench/api/providers.yaml, snapshot 2026-11-26.

| run | model | scenario | loop | capacity | bound | ours_usd_per_1m | api | api_quantization | api_usd_per_1m | u_star | pays_off |
|---|---|---|---|---|---|---|---|---|---|---|---|
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | closed | 16.0 | ceiling | 0.404 | darkbloom-fp4_9b | fp4 | 0.29 | 1.391 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | closed | 16.0 | ceiling | 0.404 | deepinfra-bf16_9b | bf16 | 0.35 | 1.153 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | closed | 16.0 | ceiling | 0.404 | together_9b | unknown | 0.59 | 0.684 | above 68% load |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | open | 1.741 | ceiling | 0.318 | darkbloom-fp4_9b | fp4 | 0.29 | 1.097 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | open | 1.741 | ceiling | 0.318 | deepinfra-bf16_9b | bf16 | 0.35 | 0.909 | above 91% load |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | open | 1.741 | ceiling | 0.318 | together_9b | unknown | 0.59 | 0.539 | above 54% load |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | closed | 16.0 | ceiling | 0.36 | darkbloom-fp4_9b | fp4 | 0.146 | 2.465 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | closed | 16.0 | ceiling | 0.36 | deepinfra-bf16_9b | bf16 | 0.17 | 2.117 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | closed | 16.0 | ceiling | 0.36 | together_9b | unknown | 0.284 | 1.267 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | open | 1.105 | SLO never broke | 0.189 | darkbloom-fp4_9b | fp4 | 0.146 | 1.296 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | open | 1.105 | SLO never broke | 0.189 | deepinfra-bf16_9b | bf16 | 0.17 | 1.113 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | open | 1.105 | SLO never broke | 0.189 | together_9b | unknown | 0.284 | 0.666 | above 67% load at most |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | closed | 4.0 | ceiling | 1.662 | darkbloom-fp4_9b | fp4 | 1.197 | 1.389 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | closed | 4.0 | ceiling | 1.662 | deepinfra-bf16_9b | bf16 | 1.483 | 1.12 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | closed | 4.0 | ceiling | 1.662 | together_9b | unknown | 2.517 | 0.66 | above 66% load |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | open | 0.186 | ceiling | 3.198 | darkbloom-fp4_9b | fp4 | 1.197 | 2.672 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | open | 0.186 | ceiling | 3.198 | deepinfra-bf16_9b | bf16 | 1.483 | 2.156 | never |
| a40_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | open | 0.186 | ceiling | 3.198 | together_9b | unknown | 2.517 | 1.271 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | closed | 4.0 | ceiling | 3.436 | alibaba_27b | unknown | 1.95 | 1.762 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | closed | 4.0 | ceiling | 3.436 | deepinfra-fp8_27b | fp8 | 3.12 | 1.101 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | closed | 4.0 | ceiling | 3.436 | siliconflow-fp8_27b | fp8 | 2.5 | 1.375 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | open | 0.259 | ceiling | 3.77 | alibaba_27b | unknown | 1.95 | 1.933 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | open | 0.259 | ceiling | 3.77 | deepinfra-fp8_27b | fp8 | 3.12 | 1.208 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | open | 0.259 | ceiling | 3.77 | siliconflow-fp8_27b | fp8 | 2.5 | 1.508 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | longgen | closed | 8.0 | ceiling | 1.653 | alibaba_27b | unknown | 1.599 | 1.034 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | longgen | closed | 8.0 | ceiling | 1.653 | deepinfra-fp8_27b | fp8 | 2.652 | 0.623 | above 62% load |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | longgen | closed | 8.0 | ceiling | 1.653 | siliconflow-fp8_27b | fp8 | 2.05 | 0.806 | above 81% load |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | longgen | open | 0.269 | ceiling | 1.446 | alibaba_27b | unknown | 1.599 | 0.905 | above 90% load |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | longgen | open | 0.269 | ceiling | 1.446 | deepinfra-fp8_27b | fp8 | 2.652 | 0.545 | above 55% load |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | longgen | open | 0.269 | ceiling | 1.446 | siliconflow-fp8_27b | fp8 | 2.05 | 0.706 | above 71% load |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | closed | 1.0 | ceiling | 13.723 | alibaba_27b | unknown | 4.16 | 3.299 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | closed | 1.0 | ceiling | 13.723 | deepinfra-fp8_27b | fp8 | 6.067 | 2.262 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | closed | 1.0 | ceiling | 13.723 | siliconflow-fp8_27b | fp8 | 5.333 | 2.573 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | open | 0.048 | ceiling | 21.406 | alibaba_27b | unknown | 4.16 | 5.146 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | open | 0.048 | ceiling | 21.406 | deepinfra-fp8_27b | fp8 | 6.067 | 3.529 | never |
| l40s_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | open | 0.048 | ceiling | 21.406 | siliconflow-fp8_27b | fp8 | 5.333 | 4.014 | never |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | closed | 32.0 | ceiling | 0.231 | darkbloom-fp4_9b | fp4 | 0.29 | 0.797 | above 80% load |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | closed | 32.0 | ceiling | 0.231 | deepinfra-bf16_9b | bf16 | 0.35 | 0.66 | above 66% load |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | closed | 32.0 | ceiling | 0.231 | together_9b | unknown | 0.59 | 0.392 | above 39% load |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | open | 4.22 | SLO never broke | 0.257 | darkbloom-fp4_9b | fp4 | 0.29 | 0.887 | above 89% load at most |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | open | 4.22 | SLO never broke | 0.257 | deepinfra-bf16_9b | bf16 | 0.35 | 0.735 | above 74% load at most |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | chat | open | 4.22 | SLO never broke | 0.257 | together_9b | unknown | 0.59 | 0.436 | above 44% load at most |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | closed | 32.0 | ceiling | 0.189 | darkbloom-fp4_9b | fp4 | 0.146 | 1.292 | never |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | closed | 32.0 | ceiling | 0.189 | deepinfra-bf16_9b | bf16 | 0.17 | 1.11 | never |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | closed | 32.0 | ceiling | 0.189 | together_9b | unknown | 0.284 | 0.664 | above 66% load |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | open | 1.241 | SLO never broke | 0.188 | darkbloom-fp4_9b | fp4 | 0.146 | 1.285 | never |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | open | 1.241 | SLO never broke | 0.188 | deepinfra-bf16_9b | bf16 | 0.17 | 1.104 | never |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | longgen | open | 1.241 | SLO never broke | 0.188 | together_9b | unknown | 0.284 | 0.661 | above 66% load at most |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | closed | 16.0 | ceiling | 0.662 | darkbloom-fp4_9b | fp4 | 1.197 | 0.553 | above 55% load |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | closed | 16.0 | ceiling | 0.662 | deepinfra-bf16_9b | bf16 | 1.483 | 0.446 | above 45% load |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | closed | 16.0 | ceiling | 0.662 | together_9b | unknown | 2.517 | 0.263 | above 26% load |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | open | 0.578 | ceiling | 1.54 | darkbloom-fp4_9b | fp4 | 1.197 | 1.287 | never |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | open | 0.578 | ceiling | 1.54 | deepinfra-bf16_9b | bf16 | 1.483 | 1.038 | never |
| rtx4090_qwen3.5-9b.24gb | Qwen/Qwen3.5-9B | rag | open | 0.578 | ceiling | 1.54 | together_9b | unknown | 2.517 | 0.612 | above 61% load |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | chat | closed | 8.0 | ceiling | 3.078 | alibaba_27b | unknown | 1.95 | 1.579 | never |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | chat | closed | 8.0 | ceiling | 3.078 | deepinfra-fp8_27b | fp8 | 3.12 | 0.987 | above 99% load |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | chat | closed | 8.0 | ceiling | 3.078 | siliconflow-fp8_27b | fp8 | 2.5 | 1.231 | never |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | chat | open | 0.924 | ceiling | 2.381 | alibaba_27b | unknown | 1.95 | 1.221 | never |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | chat | open | 0.924 | ceiling | 2.381 | deepinfra-fp8_27b | fp8 | 3.12 | 0.763 | above 76% load |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | chat | open | 0.924 | ceiling | 2.381 | siliconflow-fp8_27b | fp8 | 2.5 | 0.952 | above 95% load |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | longgen | closed | 16.0 | ceiling | 1.507 | alibaba_27b | unknown | 1.599 | 0.942 | above 94% load |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | longgen | closed | 16.0 | ceiling | 1.507 | deepinfra-fp8_27b | fp8 | 2.652 | 0.568 | above 57% load |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | longgen | closed | 16.0 | ceiling | 1.507 | siliconflow-fp8_27b | fp8 | 2.05 | 0.735 | above 74% load |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | longgen | open | 0.549 | ceiling | 0.951 | alibaba_27b | unknown | 1.599 | 0.595 | above 59% load |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | longgen | open | 0.549 | ceiling | 0.951 | deepinfra-fp8_27b | fp8 | 2.652 | 0.359 | above 36% load |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | longgen | open | 0.549 | ceiling | 0.951 | siliconflow-fp8_27b | fp8 | 2.05 | 0.464 | above 46% load |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | closed | 2.0 | ceiling | 12.534 | alibaba_27b | unknown | 4.16 | 3.013 | never |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | closed | 2.0 | ceiling | 12.534 | deepinfra-fp8_27b | fp8 | 6.067 | 2.066 | never |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | closed | 2.0 | ceiling | 12.534 | siliconflow-fp8_27b | fp8 | 5.333 | 2.35 | never |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | open | 0.211 | ceiling | 12.914 | alibaba_27b | unknown | 4.16 | 3.104 | never |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | open | 0.211 | ceiling | 12.914 | deepinfra-fp8_27b | fp8 | 6.067 | 2.129 | never |
| a100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | open | 0.211 | ceiling | 12.914 | siliconflow-fp8_27b | fp8 | 5.333 | 2.421 | never |
| h100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | closed | 4.0 | ceiling | 7.768 | alibaba_27b | unknown | 4.16 | 1.867 | never |
| h100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | closed | 4.0 | ceiling | 7.768 | deepinfra-fp8_27b | fp8 | 6.067 | 1.28 | never |
| h100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | closed | 4.0 | ceiling | 7.768 | siliconflow-fp8_27b | fp8 | 5.333 | 1.456 | never |
| h100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | open | 1.151 | SLO never broke | 3.43 | alibaba_27b | unknown | 4.16 | 0.824 | above 82% load at most |
| h100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | open | 1.151 | SLO never broke | 3.43 | deepinfra-fp8_27b | fp8 | 6.067 | 0.565 | above 57% load at most |
| h100-80gb_qwen3.5-27b.bf16 | Qwen/Qwen3.5-27B | rag | open | 1.151 | SLO never broke | 3.43 | siliconflow-fp8_27b | fp8 | 5.333 | 0.643 | above 64% load at most |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | closed | 8.0 | ceiling | 3.028 | alibaba_27b | unknown | 4.16 | 0.728 | above 73% load |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | closed | 8.0 | ceiling | 3.028 | deepinfra-fp8_27b | fp8 | 6.067 | 0.499 | above 50% load |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | closed | 8.0 | ceiling | 3.028 | siliconflow-fp8_27b | fp8 | 5.333 | 0.568 | above 57% load |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | open | 2.137 | SLO never broke | 1.894 | alibaba_27b | unknown | 4.16 | 0.455 | above 46% load at most |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | open | 2.137 | SLO never broke | 1.894 | deepinfra-fp8_27b | fp8 | 6.067 | 0.312 | above 31% load at most |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | rag | open | 2.137 | SLO never broke | 1.894 | siliconflow-fp8_27b | fp8 | 5.333 | 0.355 | above 36% load at most |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | chat | closed | 4.0 | ceiling | 3.286 | alibaba_27b | unknown | 1.95 | 1.685 | never |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | chat | closed | 4.0 | ceiling | 3.286 | deepinfra-fp8_27b | fp8 | 3.12 | 1.053 | never |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | chat | closed | 4.0 | ceiling | 3.286 | siliconflow-fp8_27b | fp8 | 2.5 | 1.314 | never |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | chat | open | 0.544 | ceiling | 2.797 | alibaba_27b | unknown | 1.95 | 1.434 | never |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | chat | open | 0.544 | ceiling | 2.797 | deepinfra-fp8_27b | fp8 | 3.12 | 0.897 | above 90% load |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | chat | open | 0.544 | ceiling | 2.797 | siliconflow-fp8_27b | fp8 | 2.5 | 1.119 | never |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | longgen | closed | 8.0 | ceiling | 1.611 | alibaba_27b | unknown | 1.599 | 1.007 | never |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | longgen | closed | 8.0 | ceiling | 1.611 | deepinfra-fp8_27b | fp8 | 2.652 | 0.607 | above 61% load |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | longgen | closed | 8.0 | ceiling | 1.611 | siliconflow-fp8_27b | fp8 | 2.05 | 0.786 | above 79% load |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | longgen | open | 0.274 | ceiling | 1.07 | alibaba_27b | unknown | 1.599 | 0.669 | above 67% load |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | longgen | open | 0.274 | ceiling | 1.07 | deepinfra-fp8_27b | fp8 | 2.652 | 0.403 | above 40% load |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | longgen | open | 0.274 | ceiling | 1.07 | siliconflow-fp8_27b | fp8 | 2.05 | 0.522 | above 52% load |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | rag | closed | 1.0 | ceiling | 12.678 | alibaba_27b | unknown | 4.16 | 3.048 | never |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | rag | closed | 1.0 | ceiling | 12.678 | deepinfra-fp8_27b | fp8 | 6.067 | 2.09 | never |
| l40s_qwen3.5-27b.int4 | Qwen/Qwen3.5-27B-GPTQ-Int4 | rag | closed | 1.0 | ceiling | 12.678 | siliconflow-fp8_27b | fp8 | 5.333 | 2.377 | never |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | closed | 16.0 | ceiling | 1.292 | alibaba_27b | unknown | 1.95 | 0.662 | above 66% load |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | closed | 16.0 | ceiling | 1.292 | deepinfra-fp8_27b | fp8 | 3.12 | 0.414 | above 41% load |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | closed | 16.0 | ceiling | 1.292 | siliconflow-fp8_27b | fp8 | 2.5 | 0.517 | above 52% load |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | open | 8.937 | ceiling | 0.5 | alibaba_27b | unknown | 1.95 | 0.256 | above 26% load |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | open | 8.937 | ceiling | 0.5 | deepinfra-fp8_27b | fp8 | 3.12 | 0.16 | above 16% load |
| h100-80gb_qwen3.5-27b.fp8 | Qwen/Qwen3.5-27B-FP8 | chat | open | 8.937 | ceiling | 0.5 | siliconflow-fp8_27b | fp8 | 2.5 | 0.2 | above 20% load |
