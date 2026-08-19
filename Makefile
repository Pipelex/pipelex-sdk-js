.DEFAULT_GOAL := help
.PHONY: help install check c test t test-e2e te clean build rebuild dev pack all depcruise use-local use-npm ul un

# Sibling repo for live mthds development (see use-local / use-npm).
MTHDS_JS_DIR := ../mthds-js

# Colors
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m

PACKAGE_NAME := @pipelex/sdk

# Helper function to print titles
define PRINT_TITLE
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo "$(BLUE)$(1)$(NC)"
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo ""
endef

define HELP
Manage $(PACKAGE_NAME) located in $(CURDIR).
Usage:

make install    - Install dependencies
make all        - Clean, check, and test
make check      - Run quality checks, excluding tests
make test       - Run the test suite
make test-e2e   - Run e2e tests against a live pipelex-api [PIPELEX_E2E_BASE_URL=...]
make dev        - Watch mode: auto rebuild on changes

make build      - Build the project
make rebuild    - Clean and rebuild
make clean      - Remove build artifacts
make depcruise  - Check architectural boundaries

make pack       - Create tarball for local npx testing

make use-local  - Switch mthds to sibling ../mthds-js (file link)
make use-npm    - Switch mthds back to npm [VERSION=x.y.z]

make c          - Shorthand -> check
make t          - Shorthand -> test
make te         - Shorthand -> test-e2e
make ul         - Shorthand -> use-local
make un         - Shorthand -> use-npm

endef
export HELP

help:
	@echo "$$HELP"

install:
	$(call PRINT_TITLE,"Installing Dependencies")
	@npm install
	@echo "$(GREEN)✓ Installation complete$(NC)"

build:
	$(call PRINT_TITLE,"Building Project")
	@npm run build
	@echo "$(GREEN)✓ Build complete$(NC)"

test:
	$(call PRINT_TITLE,"Running Tests")
	@npx vitest run
	@echo "$(GREEN)✓ All tests passed$(NC)"

t: test

# Needs a live pipelex-api server (default http://localhost:8081, override with
# PIPELEX_E2E_BASE_URL). Not part of `make test` / `make all` — CI has no server.
#
# The target and its key are resolved ONCE here and exported, so the URL this target
# preflights is the URL the suites call. Precedence follows the dotenv convention: the
# shell environment (or a `make test-e2e PIPELEX_E2E_BASE_URL=...` override) wins, then
# `.env`, then a local runner. `?=` is what enforces it — it only reaches for `.env`
# when the variable is not already set.
DOTENV = set -a; [ -f .env ] && . ./.env; set +a;
test-e2e: export PIPELEX_E2E_BASE_URL ?= $(shell $(DOTENV) printf '%s' "$${PIPELEX_E2E_BASE_URL:-http://localhost:8081}")
test-e2e: export PIPELEX_API_KEY ?= $(shell $(DOTENV) printf '%s' "$$PIPELEX_API_KEY")

# Trailing slashes are stripped the way the client normalizes `baseUrl` (`src/client.ts`),
# so a value ending in `/` cannot make the probe `//v1/version` — which a runner does not
# route — and report a live server as unreachable. It is done here, at the point of use,
# rather than on the assignment above: `?=` never fires for a value that arrived from the
# shell environment or the command line, so those two sources would keep their slash.
E2E_TARGET = $$(printf '%s' "$(PIPELEX_E2E_BASE_URL)" | sed 's:/*$$::')

# `/v1/version` is the one route BOTH a bare runner and a hosted origin serve, and it
# needs no auth — origin-level `/health` is runner-only and 404s on the hosted plane.
test-e2e:
	$(call PRINT_TITLE,"Running E2E Tests against live pipelex-api")
	@target="$(E2E_TARGET)"; curl -fs --max-time 5 -o /dev/null "$$target/v1/version" || { \
		echo "$(RED)✗ No pipelex-api reachable at $$target$(NC)"; \
		echo "  Start one: cd ../pipelex-api && make run — or point PIPELEX_E2E_BASE_URL (shell or .env) at a running instance."; \
		exit 1; \
	}
	@echo "$(YELLOW)→ target: $(E2E_TARGET)$(NC)\n"
	@npm run test:e2e
	@echo "$(GREEN)✓ All e2e tests passed$(NC)"

te: test-e2e

depcruise:
	$(call PRINT_TITLE,"Checking Architectural Boundaries")
	@npm run depcruise
	@echo "$(GREEN)✓ protocol boundary intact$(NC)"

check:
	@npm run check
	@echo "$(GREEN)✓ All checks passed$(NC)"

c: check

clean:
	$(call PRINT_TITLE,"Cleaning Build Artifacts")
	@rm -rf dist/
	@rm -rf dist-hooks/
	@rm -rf *.tsbuildinfo
	@echo "$(GREEN)✓ Clean complete$(NC)"

rebuild: clean build

all: clean check test
	@echo "$(GREEN)✓ All complete$(NC)"

dev:
	$(call PRINT_TITLE,"Watching for Changes")
	@npx tsc --watch

pack: rebuild
	$(call PRINT_TITLE,"Creating Tarball")
	@npm pack
	@echo ""
	@echo "$(GREEN)✓ Tarball created$(NC)"
	@echo "$(YELLOW)Test with: npx ./$$(npm pack --dry-run --json | node -p \"JSON.parse(require('fs').readFileSync(0,'utf-8'))[0].filename\")$(NC)"

# --- Switch mthds source ---
# use-local:  file link to sibling ../mthds-js for live development
# use-npm:    install from the npm registry (latest by default, or VERSION=x.y.z)

use-local:
	@if [ ! -d $(MTHDS_JS_DIR) ]; then echo "ERROR: $(MTHDS_JS_DIR) not found. Clone it next to pipelex-sdk-js."; exit 1; fi
	cd $(MTHDS_JS_DIR) && npm install && npm run build
	npm install mthds@file:$(MTHDS_JS_DIR)
	@echo "Switched to local mthds (file link). Run 'make use-npm' to switch back."

use-npm:
	@VERSION="$${VERSION:-latest}" && \
	echo "Installing mthds@$$VERSION from npm" && \
	npm install mthds@$$VERSION && \
	echo "Switched to npm mthds@$$VERSION. Review the diff, then commit package.json + package-lock.json."

ul: use-local
un: use-npm
