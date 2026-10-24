---
name: install
description: Install the personal claude-mem fork for Grok Bot using existing provider credentials.
---

Use the reviewed LeoLi-Goat/claude-mem checkout. Run `bun install --frozen-lockfile` and `bun run build`, then `bun dist/npx-cli/index.js install --ide grok-bot --no-auto-start`.

Keep the saved provider, gateway, model and credentials. Do not run the upstream npm installer. No CMEM account or trial is required. If no provider is saved, ask which supported personal provider to configure.

## Optional host observer

Use `--provider host` only when the user requests the host observer and the local shim is configured.
