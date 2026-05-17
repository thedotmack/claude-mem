# Redis-Compatible Dependency Strategy for Claude-Mem

Date: 2026-05-06

## Recommendation

Make BullMQ the queue engine, but do **not** treat Redis like a user-managed global service. Treat it like part of claude-mem's runtime.

Best fit for the "auto-install / it just works" product energy:

1. Prefer a claude-mem-owned local Redis-compatible sidecar process.
2. Prefer **Valkey** as the bundled/default local server where practical.
3. Accept an existing Redis/Valkey/Dragonfly URL when the user already has one.
4. Use package managers only as installers for the sidecar binary, not as long-running service managers.
5. Keep Windows as Docker/external-URL first unless we choose a supported native Redis-compatible build.

In settings and docs, call the capability `redis-compatible queue store`, but keep env names familiar:

```sh
CLAUDE_MEM_QUEUE_ENGINE=bullmq
CLAUDE_MEM_REDIS_MODE=managed|external|docker
CLAUDE_MEM_REDIS_URL=redis://127.0.0.1:<allocated-port>
```

## Why Valkey-first for managed local mode

Valkey is a Redis-compatible fork under the Linux Foundation ecosystem, has current releases, Homebrew/package-manager install paths, Docker images, and Linux binary artifacts. It also gives claude-mem a cleaner dependency story for a managed local queue store.

Redis itself is still viable. Redis Open Source 8 has changed licensing over time, while Valkey keeps the local managed dependency straightforward for "we run a Redis-compatible queue store locally."

BullMQ's own docs say BullMQ is Redis-compliant with Redis 6.2+ but warns that not all Redis alternatives work properly. So this needs CI coverage. Dragonfly is officially called out by BullMQ as a supported/tested Redis-compatible alternative, but Dragonfly's own local install path is Docker-first, which is heavier than Valkey for claude-mem's installer.

## Install decision tree

### Interactive install

1. Probe for external config:
   - If `CLAUDE_MEM_REDIS_URL` exists, test `PING`, `INFO`, BullMQ Lua/script compatibility, and `maxmemory-policy`.
   - If valid, use it and do not manage the process.

2. Probe for local compatible binaries:
   - `valkey-server`
   - `redis-server`
   - known Homebrew paths: `/opt/homebrew/bin`, `/usr/local/bin`
   - Linux package paths: `/usr/bin`, `/usr/local/bin`

3. If a binary exists, create claude-mem's own config and data dir:
   - `~/.claude-mem/redis/redis.conf`
   - `~/.claude-mem/redis/data/`
   - `~/.claude-mem/redis/redis.pid`
   - `~/.claude-mem/logs/redis-YYYY-MM-DD.log`

4. If no binary exists:
   - macOS with Homebrew: install `valkey` with `brew install valkey`.
   - Linux with supported package manager: install `valkey` using apt/dnf/yum/apk/pacman when available.
   - Linux without package support but supported Ubuntu base: download Valkey binary artifact, verify SHA256, unpack under `~/.claude-mem/bin/valkey/<version>/`.
   - Windows: use Docker if Docker is already present and running, otherwise ask for an external Redis URL or keep SQLite fallback.

5. Start the managed sidecar, then start the worker.

### Non-interactive install

Default should not block on prompts:

- If `CLAUDE_MEM_REDIS_URL` works, use it.
- Else if a local `valkey-server` or `redis-server` exists, manage it.
- Else if `--install-redis` was passed, attempt platform install.
- Else fail with a precise command to run.

Do not surprise-run `sudo apt install` or install Docker in non-interactive mode.

## Managed sidecar config

Use a private port, not global `6379`.

Allocate and persist a queue-store port the same way claude-mem persists the worker port:

```sh
CLAUDE_MEM_REDIS_HOST=127.0.0.1
CLAUDE_MEM_REDIS_PORT=<free-port>
CLAUDE_MEM_REDIS_URL=redis://127.0.0.1:<free-port>
```

Suggested config:

```conf
bind 127.0.0.1 ::1
protected-mode yes
port <allocated-port>
dir ~/.claude-mem/redis/data
daemonize no
appendonly yes
appendfsync everysec
save 60 1
maxmemory-policy noeviction
```

BullMQ specifically requires `maxmemory-policy=noeviction` for correct queue behavior and recommends AOF persistence for production durability.

Do not use the user's global Redis config. Generate a claude-mem config so the queue store has the settings BullMQ needs.

## Process model

Add `RedisManager` / `QueueStoreManager` alongside the worker supervisor:

- `ensureQueueStoreStarted()`
- `stopQueueStore()`
- `queueStoreStatus()`
- PID file with start-token validation, mirroring worker PID safety.
- Health probe:
  - TCP connect
  - `PING`
  - `INFO server`
  - `CONFIG GET maxmemory-policy`
  - `CONFIG GET appendonly`
  - BullMQ smoke queue add/get/remove in a namespaced key prefix

Worker startup sequence:

1. Load settings.
2. Ensure queue store is ready.
3. Initialize BullMQ connection.
4. Run SQLite migrations.
5. Start HTTP worker.

Shutdown sequence:

1. Stop providers/workers.
2. Close BullMQ connections.
3. Stop managed queue store only if claude-mem owns it.

## Why not global service management

Avoid making the installer do this as the default:

- `brew services start redis`
- `systemctl enable redis`
- `systemctl start valkey`

Those mutate the user's machine globally, conflict with existing Redis installs, require sudo/admin flows, and make uninstall messy.

The better UX is a private local sidecar owned by claude-mem. It starts when claude-mem starts, stores data in `~/.claude-mem`, and is removed by `npx claude-mem uninstall`.

## Platform notes

### macOS

Best path:

- If Homebrew exists: `brew install valkey`.
- Start `valkey-server` directly with claude-mem's generated config.
- Do not use `brew services`.

Redis official macOS install now uses `brew tap redis/redis` and `brew install --cask redis`, but Redis notes that this cask is not integrated with `brew services`. For claude-mem, that's fine because we should not rely on `brew services` anyway.

### Linux

Best path:

- Prefer package-manager Valkey when available.
- On Ubuntu/Debian, Valkey docs list `apt install valkey`; Ubuntu also has `valkey-redis-compat` for `redis-*` symlinks.
- For Jammy/Noble, Valkey publishes binary artifacts, which are good candidates for a claude-mem-managed install under `~/.claude-mem/bin`.

### Windows

Hardest platform.

Redis official docs say Windows Redis Open Source requires Docker, with Memurai as a Windows compatibility partner. Valkey docs say Windows is not officially supported and suggest WSL for development.

Pragmatic options:

- If Docker is installed/running, launch `valkey/valkey:<pinned>` or `redis:<pinned>` with a named volume.
- If WSL is configured, install/run Valkey inside WSL and connect from Windows.
- Otherwise require `CLAUDE_MEM_REDIS_URL` or use temporary SQLite fallback until native Windows support is chosen.

Do not auto-install Docker Desktop. It is too invasive for an "it just works" CLI installer.

## User-facing UX

Interactive:

```text
Queue engine
  BullMQ needs a local Redis-compatible queue store.
  claude-mem can manage one for you under ~/.claude-mem.

  [recommended] Manage local Valkey for me
                Use existing Redis URL
                Keep SQLite queue for now
```

Non-interactive:

```sh
npx claude-mem install --queue bullmq --install-redis
npx claude-mem install --queue bullmq --redis-url redis://127.0.0.1:6379
```

Status:

```sh
npx claude-mem status

Worker:      running on 127.0.0.1:37777
Queue:       BullMQ
Store:       managed Valkey 9.0.3 on 127.0.0.1:39241
Persistence: AOF everysec
Policy:      noeviction
```

Uninstall:

- Stop managed queue store.
- Remove managed PID/config/logs as requested.
- Preserve queue data by default unless user passes `--purge-data`.

## Implementation phases

1. Add queue-store settings and status plumbing.
2. Add `QueueStoreManager` with process spawn, PID validation, port allocation, and probes.
3. Add Valkey/Redis binary detection.
4. Add macOS/Linux install helpers.
5. Add BullMQ queue backend using managed store.
6. Add Windows Docker/external URL path.
7. Add uninstall cleanup.
8. Add CI matrix:
   - Redis 7.2 or Redis 8
   - Valkey 8/9
   - optional Dragonfly smoke test

## Final call

For claude-mem's desired UX, the winning approach is:

**BullMQ + claude-mem-managed Valkey sidecar by default, external Redis URL as an escape hatch, SQLite as short-term fallback only.**

This gives the speed and correctness of Redis/BullMQ without making users become Redis operators.
