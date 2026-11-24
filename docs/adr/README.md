# Architecture decision records

Short records of decisions that shape the results. Format: context → decision → alternatives → consequences.
A superseded ADR is not deleted: its status changes to `Superseded by NNNN`.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-serving-engine-vllm.md) | Serving engine: vLLM | Accepted |
| [0002](0002-model-family-qwen3-5.md) | Model family: Qwen3.5 (9B, 27B) | Accepted |
| [0003](0003-gpu-matrix-and-providers.md) | GPU matrix and providers | Accepted |
| [0004](0004-api-gateway.md) | API gateway: custom TypeScript service | Accepted |
| [0005](0005-load-generator.md) | Load generator: own TypeScript tool, vLLM's benchmark as cross-check | Accepted |

## Template

```markdown
# NNNN. Title

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context
## Decision
## Alternatives considered
## Consequences
```
