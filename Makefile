SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help setup hooks scan scan-history lint test bench analyze up

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
	uv run --package bench ruff check bench

test: ## Run all tests
	pnpm test

bench: ## [phase 3] Run benchmark matrix against TARGET=<url>
	@echo "Not implemented yet (phase 3)"; exit 1

analyze: ## [phase 3] Build tables and charts from results/raw
	@echo "Not implemented yet (phase 3)"; exit 1

up: ## [phase 4] Rent a GPU pod and run the lab image: GPU=<name>
	@echo "Not implemented yet (phase 4)"; exit 1
