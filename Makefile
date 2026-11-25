SHELL := /bin/bash
.DEFAULT_GOAL := help

PLAN ?= bench/plans/gpu.yaml
LABEL ?=
RUN ?=
ARGS ?=
SESSION ?= latest

.PHONY: help setup hooks scan scan-history lint test bench analyze up fetch

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## Install JS + Python deps and git hooks
	pnpm install
	uv sync --all-packages
	$(MAKE) hooks

hooks: ## Install pre-commit hooks (needs: uv tool install pre-commit)
	pre-commit install

scan: ## Scan working tree for secrets
	pre-commit run gitleaks --all-files

scan-history: ## Scan full git history for secrets (needs gitleaks binary)
	gitleaks git --redact -v .

lint: ## Lint everything
	pnpm lint
	uv run --package bench ruff check bench infra
	uv run --package bench ruff format --check bench infra
	shellcheck -x bench/*.sh infra/*.sh infra/*/*.sh

test: ## Run all tests
	pnpm test
	uv run --package bench pytest bench/tests -q
	infra/tests/bootstrap.test.sh

bench: ## Run a campaign: make bench PLAN=bench/plans/gpu.yaml LABEL=4090_qwen3.5-9b_bf16 ARGS="--model ..."
	@test -n "$(LABEL)" || { echo "LABEL is required"; exit 2; }
	bench/run_matrix.sh --plan $(PLAN) --label $(LABEL) $(ARGS)

analyze: ## Report for a run: make analyze RUN=results/raw/<dir>
	@test -n "$(RUN)" || { echo "RUN is required"; exit 2; }
	uv run --package bench python bench/analyze/analyze.py report $(RUN)

up: ## Rent a GPU and run a job: make up ARGS='--gpu RTX_3090 --max-price 0.3' (vast) or PROVIDER=runpod
	infra/$(if $(filter runpod,$(PROVIDER)),runpod,vast)/up.sh $(ARGS)

fetch: ## Download a pod session from R2 and analyse it: make fetch [SESSION=<name>|latest]
	infra/fetch.sh $(SESSION)
