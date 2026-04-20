# claude-mem Docker harness

A minimal container for exercising claude-mem end-to-end without polluting your
host. Not a dev environment — just enough to boot `claude` with the locally-built
plugin and capture observations into a throwaway SQLite DB you can inspect
afterwards.

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Image definition (node:20 + Bun + uv + Claude Code CLI + local `plugin/`) |
| `build.sh` | Runs `npm run build` then `docker build`. Tag defaults to `claude-mem:basic`. |
| `entrypoint.sh` | Runs inside the container. Seeds OAuth creds into `$HOME/.claude/` if mounted, then `exec "$@"`. |
| `run.sh` | Host-side launcher. Extracts creds (Keychain → file → env), mounts a persistent data dir, drops you into an interactive shell. |

## Quick start

```bash
# From the repo root:
docker/claude-mem/build.sh
docker/claude-mem/run.sh
```

`run.sh` drops you into `bash` inside the container with `claude` on `PATH` and
the plugin pre-staged at `/opt/claude-mem`. Launch it with:

```bash
claude --plugin-dir /opt/claude-mem
```

On exit, the SQLite DB survives at `./.docker-claude-mem-data/claude-mem.db` on
the host — inspect with:

```bash
sqlite3 .docker-claude-mem-data/claude-mem.db 'select count(*) from observations'
```

## What's in the image

Mirrors the layout of [anthropics/claude-code's devcontainer](https://github.com/anthropics/claude-code/blob/main/.devcontainer/Dockerfile):
`FROM node:20`, non-root `node` user, global `npm install -g @anthropic-ai/claude-code`.
Skips the firewall/zsh/fzf/delta/git-hist tooling since this image is about
running claude-mem, not editing code.

On top of that:

- **Bun** (`/usr/local/bun`) — claude-mem's worker service runtime
- **uv** (`/usr/local/bin/uv`) — provides Python for Chroma per `CLAUDE.md`
- **`plugin/`** copied to `/opt/claude-mem` — the locally-built plugin tree
- **`/home/node/.claude`** and **`/home/node/.claude-mem`** — pre-created mount points

Layer ordering is deliberate: plugin files are copied **after** the `npm install`
layer so iterating on the plugin doesn't bust the CLI install cache.

## Pinning versions

Everything that matters is a `--build-arg` — pin for reproducibility, omit for
latest:

```bash
docker build \
  -f docker/claude-mem/Dockerfile \
  --build-arg BUN_VERSION=1.3.12 \
  --build-arg UV_VERSION=0.11.7 \
  --build-arg CLAUDE_CODE_VERSION=1.2.3 \
  -t claude-mem:basic .
```

| Arg | Default | Notes |
|-----|---------|-------|
| `BUN_VERSION` | `1.3.12` | Installed via the official `bun.sh/install` script, tag `bun-v${BUN_VERSION}`. |
| `UV_VERSION` | `0.11.7` | Installed via the versioned `astral.sh/uv/${UV_VERSION}/install.sh`. |
| `CLAUDE_CODE_VERSION` | `latest` | npm tag or exact version. Pin in CI, let it float locally. |

## Authentication

`run.sh` picks the first auth source that works, in this order:

1. **`ANTHROPIC_API_KEY`** env var — mounted straight into the container.
2. **macOS Keychain** — `security find-generic-password -s 'Claude Code-credentials'`.
3. **`~/.claude/.credentials.json`** — legacy on-disk form, still present on some
   older CLI installs and migrated machines.

If a credentials file is used, it's written to a `mktemp` file with `chmod 600`,
mounted read-only at `/auth/.credentials.json`, and the container's entrypoint
copies it to `$HOME/.claude/.credentials.json` before exec. An `EXIT` trap
deletes the temp file when `run.sh` returns — `docker run` is deliberately **not**
`exec`'d so the trap gets a chance to fire.

If no auth source is found, `run.sh` exits with an error pointing you at
`claude login` or `ANTHROPIC_API_KEY`.

## Manual invocation (without `run.sh`)

```bash
docker run --rm -it \
  -v $(mktemp -d):/home/node/.claude-mem \
  -e CLAUDE_MEM_CREDENTIALS_FILE=/auth/.credentials.json \
  -v /path/to/creds.json:/auth/.credentials.json:ro \
  claude-mem:basic
```

Or with API key auth:

```bash
docker run --rm -it \
  -v $(mktemp -d):/home/node/.claude-mem \
  -e ANTHROPIC_API_KEY \
  claude-mem:basic
```

## Environment variables

| Var | Where | Purpose |
|-----|-------|---------|
| `TAG` | `build.sh`, `run.sh` | Override image tag (default `claude-mem:basic`). |
| `HOST_MEM_DIR` | `run.sh` | Override host path for the persistent `.claude-mem` volume (default `$REPO_ROOT/.docker-claude-mem-data`). |
| `ANTHROPIC_API_KEY` | `run.sh`, entrypoint | API-key auth. Skips the OAuth creds extraction. |
| `CLAUDE_MEM_CREDENTIALS_FILE` | entrypoint | Path (inside the container) to a mounted OAuth creds JSON. Copied to `$HOME/.claude/.credentials.json` at startup. |

## Passing args through

Anything after `run.sh` is forwarded to the container as the command:

```bash
docker/claude-mem/run.sh claude --plugin-dir /opt/claude-mem --print "what did we learn yesterday?"
```

## Cleanup

```bash
rm -rf .docker-claude-mem-data   # wipes the persistent DB + Chroma store
docker rmi claude-mem:basic       # removes the image
```
