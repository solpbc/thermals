# SPDX-License-Identifier: AGPL-3.0-only
.PHONY: install test ci format clean dev deploy schema schema-local seed

install:
	npm install

test:
	node --test test/*.test.js

# Format check + lint + type check + test. Pre-commit gate.
# No formatter/linter wired yet (zero-runtime-dep worker); ci == test.
ci: test

format:
	@echo "no formatter wired (dependency-light worker); nothing to format"

clean:
	rm -rf node_modules .wrangler

dev:
	npx wrangler dev

deploy:
	npx wrangler deploy

# Apply schema to the remote D1 (run after provisioning the database).
schema:
	npx wrangler d1 execute thermals-appview --remote --file=schema.sql

# Apply schema to the local dev D1.
schema-local:
	npx wrangler d1 execute thermals-appview --local --file=schema.sql

# Kick a one-shot index cycle against a running dev worker (Jetstream + commons poll).
seed:
	curl -s "http://localhost:8787/api/_index_now" | head -c 400; echo
