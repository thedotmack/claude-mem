# [plan-07] Server Runtime GA — graduate server-beta to a first-class runtime

## Defect

The standalone server runtime was extracted from `worker-service` but never inherited the worker's startup, auth, deployment, and operability guarantees. It is shipped under a "beta" label, yet the gaps are not stylistic — they are structural: the server can boot into a non-functional state (no mode loaded), its auth contract disagrees with its own route middleware, its container stack has no supervision, its CLI cannot perform routine operator tasks, and there is no install/uninstall/test path for it at all. The decision is **not** to remove the server runtime — it is to **remove the beta label**, which means closing every parity and hardening gap so the server runtime is as trustworthy as the in-plugin worker.

## Children

- #2428 — server-beta API key scopes (default `memories:read`) don't match the scopes the local route middleware actually requires
- #2443 — `server-beta-service` never calls `loadMode('code')` → every generation job fails with "No mode loaded"
- #2444 — `runServerBetaCli()` default `start` spawns a daemon and exits → unusable under systemd `Type=simple`
- #2540 — tracking issue for the multi-PR server-beta contribution series
- #2541 — API keys persisted as unsalted single-round SHA-256 → offline-crackable if the DB leaks (needs argon2id + timing-safe verify)
- #2543 — `claude-mem install` has no end-to-end setup for the server runtime (Docker + pg + redis, key gen, IDE MCP injection)
- #2550 — no end-to-end test exercising the server runtime path
- #2552 — Viewer UI unreachable on the server runtime (no static handler / API compat layer mounted)
- #2554 — no subscription auth path; API-key-only is prohibitively expensive; stale `DEFAULT_MODEL` → 404; loopback ECONNREFUSED in Docker
- #2558 — Docker stack: no restart policy, brittle `REDIS_URL` env, no credentials-file mount
- #2560 — Postgres schema gaps (missing `platform_source`/`metadata`/indexes), no key-scope migration tool, missing batch route
- #2562 — `api-key-service.ts` filename hides which auth backend it implements (DX)
- #2564 — hooks have no runtime selector; can't switch worker ↔ server without reinstall
- #2568 — `claude-mem uninstall` only knows the worker runtime; server operators must tear down manually
- #2572 — Server CLI missing `api-key`/`keys`/`jobs` subcommands, no helmet hardening, no wrong-runtime guard

## Fix sequence

1. **Boot correctness:** call `loadMode('code')` (and validate a mode is loaded) before the server accepts jobs; fail fast if not (#2443). Make `start` run in the foreground by default with an explicit `--daemon` flag (#2444).
2. **Auth contract:** reconcile API-key scope defaults with the route middleware's required scopes; add a scope-migration tool; move key hashing to argon2id with timing-safe verification (#2428, #2541, #2560).
3. **Deployment hardening:** Docker stack gets a restart policy, a Redis env fallback, and a credentials-file mount; document subscription vs API-key auth and fix the stale default-model 404 + loopback ECONNREFUSED (#2554, #2558).
4. **Operability:** complete the server CLI (`api-key`/`keys`/`jobs`), add helmet, add a wrong-runtime guard; mount the Viewer UI / API compat layer on the server runtime (#2572, #2552).
5. **Install / uninstall / switch:** end-to-end `claude-mem install --runtime server` and matching uninstall; a hook-level runtime selector so users switch worker ↔ server without reinstall (#2543, #2568, #2564).
6. **Tests + rename:** an end-to-end server-runtime test in CI; rename `api-key-service.ts` to reveal its backend (#2550, #2562). Land via the tracked PR series (#2540).
7. **Drop the beta label** only once 1–6 land and the server runtime passes the same matrix as the worker.

## Test matrix

| Deployment | Auth mode | Required behavior |
|---|---|---|
| Docker compose | API key | Boots with mode loaded; restart policy recovers a killed container; jobs succeed |
| Docker compose | Subscription | Auth path documented + functional; no API-key cost surprise |
| systemd `Type=simple` | API key | `start` stays in foreground; unit does not flap |
| Bare `claude-mem install --runtime server` | API key | Install wires pg+redis+keys+MCP; uninstall fully tears down |
| Switch worker→server (no reinstall) | either | Runtime selector flips; observations resume on the new runtime |

The matrix lives in CI (#2550). A server-runtime regression must fail CI before a user can file.

## Out of scope

- Worker-runtime-only lifecycle bugs → plan-03.
- Generic installer error taxonomy (non-server) → plan-04.
- Host env contamination of the Anthropic subprocess → plan-06.
- New provider backends (Vertex/DeepSeek/OpenAI-compatible) → tracked as standalone feature requests.
