.DEFAULT_GOAL := help

NPM ?= bun
PORT ?= 37777

.PHONY: help install build build-and-sync test test-parser test-context test-context-verbose \
        sync sync-force worker-start worker-stop worker-restart worker-logs \
        worker-logs-no-flush viewer

help:
	@echo "Claude-Mem local dev:"
	@echo "  install                  Install dependencies"
	@echo "  build                    Build hooks"
	@echo "  build-and-sync           Build, sync to marketplace, restart worker (most common)"
	@echo "  test                     Run vitest suite"
	@echo "  test-parser              Run parser test"
	@echo "  test-context             Smoke test context hook"
	@echo "  test-context-verbose     Context hook with verbose logs"
	@echo "  sync                     Sync plugin to marketplace"
	@echo "  sync-force               Force sync to marketplace"
	@echo "  worker-start             Start Bun worker"
	@echo "  worker-stop              Stop Bun worker"
	@echo "  worker-restart           Restart Bun worker"
	@echo "  worker-logs              Tail worker logs (flush cache)"
	@echo "  worker-logs-no-flush     Tail worker logs (no flush)"
	@echo "  viewer                   Show viewer URL"

install:
	$(NPM) install

build:
	$(NPM) run build

build-and-sync: build sync
	@sleep 1
	@cd ~/.claude/plugins/marketplaces/thedotmack && $(NPM) run worker:restart
	@echo "✓ Build, sync, and worker restart complete"

test:
	$(NPM) test

test-parser:
	$(NPM) run test:parser

test-context:
	$(NPM) run test:context

test-context-verbose:
	$(NPM) run test:context:verbose

sync:
	$(NPM) run sync-marketplace

sync-force:
	$(NPM) run sync-marketplace:force

worker-start:
	$(NPM) run worker:start

worker-stop:
	$(NPM) run worker:stop

worker-restart:
	$(NPM) run worker:restart

worker-logs:
	$(NPM) run worker:logs

worker-logs-no-flush:
	tail -f ~/.claude-mem/logs/worker-$(shell date +%Y-%m-%d).log

viewer:
	@echo "Viewer UI: http://localhost:$(PORT)"
