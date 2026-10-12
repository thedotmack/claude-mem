# Observation TV — read-only broadcast + shared-secret token

**Date:** 2026-09-05
**Worktree / branch:** `.claude/worktrees/observation-tv` / `worktree-observation-tv`
**Builds on:** commit `8489f78b` — *feat(ui): observation TV — fullscreen fading titles off the existing SSE stream*
**Live status doc:** `/workspace/obs-broadcast/STATUS.md`
**Distinct from:** Pepper / Booth X Live. Nothing here touches those.

---

## Primary goal

**Alex can open Observation TV on a second device on his LAN — phone, iPad, spare monitor — and that
device can see observation titles stream by, and can do NOTHING ELSE to the worker.** Not restart it,
not read `~/.claude-mem/settings.json`, not delete an observation, not import rows, not toggle MCP.

Everything below is measured against that sentence. A task that does not move a request from
"the whole worker API is reachable" toward "exactly four read-only paths are reachable, and only
with the secret" does not belong in this plan.

**Locked decision (Prioritizer, 2026-09-05):**
- Local-only for now. No phone-over-internet expose in this slice.
- Build **option (b)**: read-only broadcast surface + shared-secret token.
- **cloudflared / any tunnel in front of the unmodified worker is REJECTED.** It publishes
  `POST /api/admin/restart`, `POST /api/settings`, and `GET /api/settings` (which returns the
  user's Gemini and OpenRouter API keys in plaintext) to the open internet. Do not propose it
  again in this plan's phases, in comments, or in docs.

---

## The problem in one paragraph

The worker's entire HTTP surface — **45+ routes across 13 route classes** — has *no request
authentication of any kind*. Its only defence is the loopback bind. The codebase says so out loud:
`src/server/runtime/ServerService.ts:129-131` turns on hardening headers for the server runtime with
the comment *"server runtime is reachable over the network in Docker, so it emits hardening headers
(the worker, loopback-only, does not)."* `requireLocalhost` (`src/services/worker/http/middleware.ts:64-86`)
guards only three routes: `/api/admin/restart`, `/api/admin/shutdown`, `/api/admin/doctor`
(`src/services/server/Server.ts:291,305,326`). Everything else — `POST /api/settings`,
`GET /api/settings`, `DELETE /api/observation/:id`, `POST /api/import`, `POST /api/logs/clear`,
`DELETE /api/corpus/:name`, `ALL /api/auth/*splat` — is wide open to anything that can reach the port.
So flipping `CLAUDE_MEM_WORKER_HOST=0.0.0.0` today does not "put the TV on the LAN"; it puts the
**entire memory database, the settings writer, and the provider API keys** on the LAN.

**The fix shape:** one guard middleware, mounted first, that is a *no-op for loopback* and for
non-loopback requests is *default-deny with a four-path allowlist behind a shared secret*.

---

## Binding constraints

1. **Allowlist, never denylist.** The route count grows every release. A denylist is a list of
   the routes someone remembered; the next PR adds route 46 and it is remote-readable by default.
2. **No new dependency.** No `helmet`, no `express-rate-limit`, no `passport`, no `jsonwebtoken`.
   The repo has a documented policy against exactly this (`Server.ts:96-105`: helmet was declined
   and the headers hand-rolled to keep the esbuild bundle unchanged).
3. **Default behavior is byte-identical to today.** Token unset ⇒ guard is not mounted ⇒ nothing
   changes for any existing install, including the documented Docker `0.0.0.0` setup
   (`docs/docker.md:12`).
4. **`CLAUDE_MEM_WORKER_HOST` default stays `127.0.0.1`.** This plan never changes it. It documents
   how to change it and what the token does when you do.
5. Diffs the size of the defect. Do not refactor `Server.ts`, do not restructure the route classes.
6. Do not edit `CHANGELOG.md` (generated).

---

## Phase 0 — Consolidated discovery (READ THIS; DO NOT RE-DERIVE)

Verified 2026-09-05 against `worktree-observation-tv` @ `8489f78b` by direct file reads. Every claim
below carries a `file:line`. If a later phase's instruction disagrees with something here, stop and
re-read the file — do not guess.

### 0.1 How the express app is assembled

`src/services/server/Server.ts:119-134` — the constructor, in exact order:

```ts
127: this.app = express();
128: this.app.disable('x-powered-by');
129: this.setupSecurityHeaders();   // Server.ts:198-206 — opt-in via options.securityHeaders
130: this.setupCors();              // Server.ts:208-210
131: this.setupPreBodyParserRoutes(); // Server.ts:212-214 — mounts ALL /api/auth/*splat
132: this.setupMiddleware();        // Server.ts:193-196 — json parser, logger, express.static
133: this.setupCoreRoutes();        // Server.ts:216-366 — mounts /api/admin/*, /api/health, ...
```

Then, **after construction**, `src/services/worker-service.ts:299` calls `registerRoutes()`
(`worker-service.ts:314-366`), which mounts Chroma → an init gate → Viewer → Session → Data →
Settings → Logs → Memory → ServerV1. Three more classes mount later still, inside
`initializeBackground()`: SearchRoutes (`worker-service.ts:564`), CorpusRoutes (`:573`),
CloudSyncRoutes (`:580`).

**Consequence that decides the design:** the only position that covers `/api/auth/*` (mounted at
constructor step 131), `/api/admin/*` (step 133), the static file mount (step 132), *and* every
route added later — including routes that do not exist yet — is **position zero, at the very top of
the constructor.** Anything mounted afterwards leaves earlier routes uncovered.

### 0.2 What already exists that we will copy

| Thing | Location | Why it matters here |
|---|---|---|
| `requireLocalhost(req,res,next)` | `src/services/worker/http/middleware.ts:64-86` | The house idiom for an IP check: reads `req.ip \|\| req.connection.remoteAddress`, compares against `127.0.0.1` / `::1` / `::ffff:127.0.0.1` / `localhost`, logs `logger.warn('SECURITY', ...)`, answers `403` JSON. **Copy this file's shape for the new guard.** |
| `isLocalhost(req)` | `src/server/middleware/request-auth-helpers.ts:15-21` | Identical check, already extracted as a pure helper, already unit-testable. Prefer importing this over re-implementing. |
| `parseBearerToken(header)` | `src/server/middleware/request-auth-helpers.ts:10-13` | `/^Bearer\s+(.+)$/i` → trimmed token or `null`. Copy-ready. |
| `hasForwardedClientHeaders(req)` | `src/server/middleware/request-auth-helpers.ts:44-51` | Detects `forwarded` / `x-forwarded-for` / `x-forwarded-host` / `x-real-ip`. Used in the existing auth to refuse a "loopback" claim that came through a proxy. |
| Header precedence `Bearer` → `X-Api-Key` | `src/server/middleware/auth.ts:40-46` | The established order and the exact 401 message wording. |
| `safeEqualHex(a,b)` | `src/server/auth/sqlite-api-key-service.ts:83-97` | Length pre-check then `crypto.timingSafeEqual`, with a `logger.warn` on malformed input. **Copy this verbatim shape** for the token comparison. |
| `createRawServerApiKey()` | `src/server/auth/sqlite-api-key-service.ts:155-157` | `` `cmem_${randomBytes(32).toString('base64url')}` `` — the house secret-minting idiom. |
| Opt-in `ServerOptions` flag | `src/services/server/Server.ts:88-93` (`securityHeaders?: boolean`) + `:198-206` | The precedent for "a Server capability the worker opts into and the other runtime does not". **Model the new option on this exactly.** |
| "Feature is on iff the token setting is non-empty" | `src/services/worker/DatabaseManager.ts:39-47` (CloudSync) | The house pattern for a secret-gated optional subsystem. Comment at `:39-41` explains the reasoning. |
| Settings declaration + default | `src/shared/SettingsDefaultsManager.ts:22-131` (interface), `:134-238` (defaults) | Where a new `CLAUDE_MEM_*` key is declared. `CLAUDE_MEM_CLOUD_SYNC_TOKEN: ''` at `:200` is the nearest analogue. |
| Settings read | `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)` — `worker-service.ts:453`, `DatabaseManager.ts:23` | The canonical read. **See the trap in 0.5.** |
| Settings write whitelist | `src/services/worker/http/routes/SettingsRoutes.ts:77-108` | Keys absent from this array **cannot be written** through `POST /api/settings`. Chroma / Telegram / CloudSync keys are all deliberately absent. |
| Test harness for a booted Server | `tests/server/server-security-headers.test.ts:10-45` | Real `new Server(baseOptions({...}))`, `await server.listen(randomPort, '127.0.0.1')`, then `fetch`. **Copy this file as the skeleton for the guard tests.** |
| Docs table format | `docs/public/configuration.mdx:14-24` | `\| \`CLAUDE_MEM_X\` \| \`default\` \| one-line description \|` |

### 0.3 The routes, grouped by what a remote request must NOT reach

Complete inventory taken from a `.get(|.post(|.put(|.patch(|.delete(|.all(` sweep over
`src/services/worker/http/`, `src/services/server/Server.ts`, `src/server/auth/BetterAuthRoutes.ts`,
`src/server/routes/v1/ServerV1Routes.ts`.

**Catastrophic if remote (secrets / process control / destruction):**

| Route | File:line | Guard today | What it gives an attacker |
|---|---|---|---|
| `GET /api/settings` | `SettingsRoutes.ts:29` | **none** | Returns the whole settings file: `CLAUDE_MEM_GEMINI_API_KEY`, `CLAUDE_MEM_OPENROUTER_API_KEY`, `CLAUDE_MEM_CLOUD_SYNC_TOKEN`, `CLAUDE_MEM_CHROMA_API_KEY` |
| `POST /api/settings` | `SettingsRoutes.ts:30` | **none** | Rewrites provider/model/host/port config |
| `POST /api/admin/restart` | `Server.ts:291` | `requireLocalhost` | Kills the worker |
| `POST /api/admin/shutdown` | `Server.ts:305` | `requireLocalhost` | Kills the worker |
| `GET /api/admin/doctor` | `Server.ts:326` | `requireLocalhost` | pids, env-clean state, dependency dump |
| `DELETE /api/observation\|summary\|prompt/:id` | `DataRoutes.ts:93,94,95` | **none** | Irreversible row deletion |
| `POST /api/import` | `DataRoutes.ts:102` | **none** | Bulk-writes into the memory DB |
| `DELETE /api/corpus/:name` | `CorpusRoutes.ts:76` | **none** | Destroys a built knowledge corpus |
| `POST /api/logs/clear` | `LogsRoutes.ts:85` | **none** | Erases the audit trail |
| `POST /api/mcp/toggle` | `SettingsRoutes.ts:34` | **none** | Disables the MCP subsystem |
| `ALL /api/auth/*splat` | `BetterAuthRoutes.ts:31` | **none** | better-auth: sessions, orgs, **API-key issuance** |

**Bulk data read (every project on the box, full text):** `GET /api/observations`, `/api/summaries`,
`/api/prompts`, `/api/observation/:id`, `/api/observations/by-file`, `/api/session/:id`,
`/api/prompt/:id`, `/api/stats`, `/api/projects`, `/api/logs`, `/api/search*`, `/api/timeline*`,
`/api/context/*` — `DataRoutes.ts:83-100`, `LogsRoutes.ts:84`, `SearchRoutes.ts:146-158`.

**Everything under `/v1/*`** (`ServerV1Routes.ts:73-260`) — already behind `requireServerAuth`, and
stays behind it; the new guard denies it remotely as well, belt and braces.

**The four the TV actually needs:** `GET /tv` (`ViewerRoutes.ts:162`), `GET /tv.html` (served by
`express.static(plugin/ui)` at `middleware.ts:36-38`), `GET /stream` (`ViewerRoutes.ts:164`,
handler `:224-266`), `GET /api/observations` (`DataRoutes.ts:83`, handler `:104-109`).

Confirmed from the page itself — `src/ui/tv.html` makes exactly two network calls:
`fetch('/api/observations?' + qs)` at `tv.html:265` and `new EventSource('/stream')` at `tv.html:277`.
Nothing else. tv.html is dependency-free with no external resources, so it needs **zero** static assets.

### 0.4 Existing middleware, and what it does and does not do

- **CORS** — `middleware.ts:43-62`, mounted globally at `Server.ts:208-210`. Rejects an `Origin`
  that is not `http://localhost:*` / `http://127.0.0.1:*` by calling `next(new Error('CORS not allowed'))`.
  Two things to know: (a) it only fires when an `Origin` header is present, so `curl` and
  `EventSource` from a same-origin page sail past it; (b) it is **not** a security boundary — CORS
  restricts what a *browser page from another origin* may read, not what a device on the LAN may request.
- **No `trust proxy`.** Verified: `app.set('trust proxy', ...)` appears nowhere in `Server.ts` or
  `worker-service.ts`. So `req.ip` is the real socket peer and `X-Forwarded-For` is ignored by
  Express — an attacker **cannot** spoof a loopback `req.ip` with a header. Good. Do not add
  `trust proxy` in this plan; it would break that property.
- **Request logger** — `middleware.ts:12-34`. Logs `req.path`, which in Express **excludes the query
  string**. So a `?token=` never reaches the log file through this path. This is load-bearing for
  the query-param decision in Phase 2 — do not "improve" the logger to log `req.originalUrl`.
- **`finalizeRoutes()` is never called on the worker.** Verified: `grep -rn finalizeRoutes src/`
  returns the definition at `Server.ts:187-191` and exactly one call site,
  `src/server/runtime/ServerService.ts:217` (the *other* runtime). The worker therefore has **no**
  `notFoundHandler` and **no** terminal `errorHandler`. **Consequence:** the new guard must write its
  own response. Never `next(err)` from it — that lands in Express's default handler and returns an
  HTML stack page.
- **No rate limiting exists for HTTP.** `globalRateLimitStore` (`src/services/worker/RateLimitStore.ts:101`)
  tracks *LLM provider* quota, consumed only at `ClaudeProvider.ts:303,317` and reported at
  `Server.ts:239`. `src/server/middleware/rate-limit.ts` is Postgres-backed and wired only into the
  Server-Beta Postgres routes. **Neither is reusable here.** Do not try.

### 0.5 Traps

1. **`SettingsDefaultsManager.get(key)` does NOT read `settings.json`.** `SettingsDefaultsManager.ts:245-247`
   is `return process.env[key] ?? this.DEFAULTS[key]`. A token written to `~/.claude-mem/settings.json`
   is invisible to `.get()`. The token must be read with
   `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)` — as CloudSync does
   (`DatabaseManager.ts:23`, `worker-service.ts:453`). Precedence is env > settings.json > DEFAULTS
   (`applyEnvOverrides`, `SettingsDefaultsManager.ts:253-261`).
2. **`SettingsManager` ≠ `SettingsDefaultsManager`.** `src/services/worker/SettingsManager.ts` is a
   SQLite `viewer_settings` table holding `sidebarOpen` / `selectedProject` / `theme`. Unrelated.
   Do not put the token there.
3. **EventSource cannot set request headers.** This is a hard constraint of the browser API and it is
   the *only* reason a query parameter is in the design. It is not laziness.
4. **`/tv.html` is served by `express.static`, not by a route handler.** `middleware.ts:36-38` mounts
   `plugin/ui`; `ViewerRoutes.ts:157-158` additionally mounts `ui`. Both sit inside the constructor,
   so both are behind a position-zero guard. A guard mounted in `ViewerRoutes.setupRoutes` would be
   too late for `middleware.ts:36`.
5. **The environment has no `node_modules`.** Per STATUS.md, the previous session could not run
   `npm run build` or `tsc`. Phase 1 begins with `npm install`; if it fails, say so and stop rather
   than shipping type-unchecked route code.

### 0.6 Allowed APIs (use only these; anything else, go read the file first)

From `express`: `RequestHandler`, `Request`, `Response`, `NextFunction`, `req.ip`, `req.socket.remoteAddress`,
`req.method`, `req.path`, `req.query`, `req.header(name)`, `res.status().json()`, `res.setHeader()`.
From `node:crypto`: `randomBytes`, `createHash`, `timingSafeEqual`.
From the repo: `logger` (`src/utils/logger.js`), `isLocalhost` / `parseBearerToken` / `hasForwardedClientHeaders`
(`src/server/middleware/request-auth-helpers.js`), `SettingsDefaultsManager`
(`src/shared/SettingsDefaultsManager.js`), `USER_SETTINGS_PATH` / `paths.settings()` (`src/shared/paths.js`).

### 0.7 Anti-patterns — do not do these

- ❌ **cloudflared / ngrok / any tunnel to the unmodified worker.** Rejected by decision. See the
  catastrophic-routes table for why.
- ❌ **Reusing `requireServerAuth` / better-auth for the TV.** Deliberate rejection, not an oversight.
  It is DB-backed (`verifyServerApiKey` → `AuthRepository` → `bun:sqlite`), scope-based, and needs
  the DB open — but the TV must render during the init window when `worker-service.ts:328-351`
  is still answering `503` for `/api/*`. It also cannot authenticate an `EventSource`. Park it for Pro
  (Appendix A).
- ❌ **A denylist of "dangerous" routes.** See constraint 1.
- ❌ **Adding a dependency** (helmet / express-rate-limit / passport / jsonwebtoken / cors).
- ❌ **Inventing a scopes system, a JWT, a login page, or a session cookie.** One shared secret.
- ❌ **Changing the `CLAUDE_MEM_WORKER_HOST` default to `0.0.0.0`.**
- ❌ **`app.set('trust proxy', true)`.** It would let a header spoof loopback (0.4).
- ❌ **`next(err)` from the guard.** No error handler exists on the worker (0.4).
- ❌ **`===` on the token.** Non-constant-time. Use the `safeEqualHex` shape.
- ❌ **Logging the token**, at any level, including `logger.debug`. Log a `sha256:<first8>` fingerprint if you must.
- ❌ **Adding `CLAUDE_MEM_TV_TOKEN` to the `settingKeys` array** in `SettingsRoutes.ts:77-108`. See Phase 1 task 3.

---

## Phase 1 — The setting: `CLAUDE_MEM_TV_TOKEN`

**How this serves the primary goal:** the token is the single switch. Empty ⇒ no remote surface at
all and today's behavior unchanged. Non-empty ⇒ the guard exists and the four paths open to whoever
holds it.

### 1.1 Declare the setting

`src/shared/SettingsDefaultsManager.ts` — add to the `SettingsDefaults` interface (block `:22-131`)
and to `DEFAULTS` (block `:134-238`). Copy the shape of `CLAUDE_MEM_CLOUD_SYNC_TOKEN: ''` at `:200`:

```ts
  // Observation TV remote broadcast. EMPTY = OFF: the read-only guard is not
  // mounted and the worker behaves exactly as before. Set (with a non-loopback
  // CLAUDE_MEM_WORKER_HOST) to expose ONLY /tv, /tv.html, /stream and
  // GET /api/observations to holders of this secret. Mint with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  CLAUDE_MEM_TV_TOKEN: '',
```

### 1.2 Read it the way CloudSync does

Copy `src/services/worker/DatabaseManager.ts:39-47` — the "active iff the secret is non-empty" shape.
The read site is `src/services/worker-service.ts:453`, which already holds
`const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)`.

**Do not** use `SettingsDefaultsManager.get('CLAUDE_MEM_TV_TOKEN')` (trap 0.5.1).

Normalize once: `const tvToken = (settings.CLAUDE_MEM_TV_TOKEN ?? '').trim()`. A whitespace-only
token is OFF, not a secret equal to a space.

### 1.3 Deliberately do NOT expose it through the settings API or UI

Leave `CLAUDE_MEM_TV_TOKEN` **out** of the `settingKeys` array at `SettingsRoutes.ts:77-108`, out of
`src/ui/viewer/constants/settings.ts`, out of `src/ui/viewer/types.ts`, and out of
`ContextSettingsModal.tsx`.

Reasoning, to be written as a code comment at the `settingKeys` array so the next person does not
"fix" the omission: `POST /api/settings` has no authentication (`SettingsRoutes.ts:30`). If the token
were writable there, any page the user visits could `fetch('http://127.0.0.1:37700/api/settings', {method:'POST', ...})`
and set a token it chose, then read the memory DB from the LAN. Keeping it off the whitelist means
the token can only be set by the person who has the filesystem or the environment. This matches how
every Chroma / Telegram / CloudSync key is already handled.

Known residual exposure to state in the plan and the docs, not to fix here: `GET /api/settings`
(`SettingsRoutes.ts:37-42`) returns the whole file, so the token is readable by anything already on
loopback — exactly like `CLAUDE_MEM_GEMINI_API_KEY` is today. Redacting it there would break the
settings modal's read-modify-write round trip and is a separate change.

### 1.4 Mint-a-token helper

Add a tiny exported helper next to the guard (Phase 2), not a new CLI surface:

```ts
export function generateTvToken(): string {
  return randomBytes(32).toString('base64url');
}
```

Copy the idiom from `createRawServerApiKey()` (`src/server/auth/sqlite-api-key-service.ts:155-157`)
but **without** the `cmem_` prefix — that prefix means "a DB-backed scoped API key" in this codebase
and this is not one.

### 1.5 Verification checklist — Phase 1

```bash
npm install                      # prerequisite; see trap 0.5.5
npm run typecheck                # tsc --noEmit && viewer tsconfig
grep -n "CLAUDE_MEM_TV_TOKEN" src/shared/SettingsDefaultsManager.ts   # expect 2 hits: interface + default
grep -rn "CLAUDE_MEM_TV_TOKEN" src/services/worker/http/routes/SettingsRoutes.ts  # expect 0 hits
grep -rn "CLAUDE_MEM_TV_TOKEN" src/ui/                                # expect 0 hits
grep -rn "SettingsDefaultsManager.get('CLAUDE_MEM_TV_TOKEN')" src/    # expect 0 hits (trap 0.5.1)
```

- [ ] `npm run typecheck` passes.
- [ ] A fresh `~/.claude-mem/settings.json` (delete it, boot the worker) contains
      `"CLAUDE_MEM_TV_TOKEN": ""`.
- [ ] `POST /api/settings` with `{"CLAUDE_MEM_TV_TOKEN":"pwned"}` returns success **and the file is
      unchanged** — the key is not on the whitelist. This is the test that proves 1.3.

---

## Phase 2 — The guard: `createRemoteReadOnlyGuard`

**How this serves the primary goal:** this is the whole security boundary. Everything else in the
plan is setting, plumbing, or documentation.

### 2.1 Where the code goes

New export in `src/services/worker/http/middleware.ts`, directly beneath `requireLocalhost`
(`:64-86`). Same file, same style, same `logger.warn('SECURITY', ...)` idiom. Do not create a new
directory; `src/services/worker/http/middleware/` currently holds only `validateBody.ts` and is for
per-route validators.

### 2.2 The contract

```ts
export interface RemoteReadOnlyOptions {
  /** Called per request. Empty string ⇒ this guard should never have been mounted. */
  getToken: () => string;
}

export function createRemoteReadOnlyGuard(options: RemoteReadOnlyOptions): RequestHandler;
```

Behavior, in this exact order — write it in this order, because each step depends on the one before:

1. **Loopback ⇒ `next()` immediately.** Use `isLocalhost(req)` from
   `src/server/middleware/request-auth-helpers.js:15-21`. Additionally refuse the loopback claim if
   `hasForwardedClientHeaders(req)` is true (`:44-51`) — copy that composition from
   `src/server/middleware/auth.ts:48-56`. Nothing about local behavior changes, ever.
2. **Method gate.** If `req.method` is not `GET` or `HEAD` ⇒ `403`. One line that kills every
   mutation, including future ones and including `ALL /api/auth/*splat`.
3. **Path allowlist.** Exact-match set, no prefixes, no regex, no `startsWith`:
   ```ts
   const REMOTE_READABLE_PATHS: ReadonlySet<string> = new Set([
     '/tv',
     '/tv.html',
     '/stream',
     '/api/observations',
   ]);
   ```
   Not in the set ⇒ **`404`** with a bare `{ error: 'Not found' }`. 404 rather than 403 so a LAN
   scanner learns nothing about what the worker is or which paths exist. Compare `req.path` (query
   string already excluded by Express — 0.4).
   **Note `/api/observations` is exact**, so `/api/observations/by-file` (`DataRoutes.ts:88`) and
   `POST /api/observations/batch` (`:89`) are both denied. That is intended.
4. **Token extraction**, in the precedence established at `src/server/middleware/auth.ts:40-46`:
   `parseBearerToken(req.header('authorization') ?? '')` → `req.header('x-api-key')?.trim()` →
   `req.query.token` (string only; if `Array.isArray`, reject — a repeated `?token=` is not a
   valid request).
   The query parameter exists solely because `EventSource` cannot set headers (trap 0.5.3).
5. **Constant-time compare.** SHA-256 both sides to a fixed length, then `timingSafeEqual`. Copy the
   `safeEqualHex` shape from `src/server/auth/sqlite-api-key-service.ts:83-97` including its
   length pre-check and its `try/catch` + `logger.warn`:
   ```ts
   const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
   // both are always 32 bytes, so timingSafeEqual never throws on length
   ```
   No token / wrong token ⇒ **`401`** with
   `{ error: 'Unauthorized', message: 'Missing or invalid Observation TV token' }` — wording copied
   from `auth.ts:70-76`.
6. **Pass ⇒ `next()`**, plus `res.setHeader('Cache-Control', 'no-store')`.

**Never** `next(err)` — write the response (0.4).

### 2.3 Logging

- On a denied non-loopback request: `logger.warn('SECURITY', 'Remote request denied', { path: req.path, method: req.method, clientIp, reason })`
  where `reason` ∈ `'method'|'path'|'token'`. Copy the field shape from `middleware.ts:74-78`.
- **Never log the token or the raw query string.** If a fingerprint helps debugging, log
  `createHash('sha256').update(presented).digest('hex').slice(0,8)`.
- Rate-limit the warn to avoid a scanner filling the log: keep a module-level counter and log at
  most once per second per `clientIp`, or simply log at `debug` after the first 10 from an IP. Keep
  this to ~10 lines; do not build a rate-limiter abstraction.

### 2.4 Mounting it

`src/services/server/Server.ts`:

- Add to `ServerOptions` (block `:76-94`), modeled exactly on `securityHeaders?: boolean` at `:88-93`
  including a comment explaining who opts in:
  ```ts
  /**
   * Observation TV remote broadcast. When present, a guard runs BEFORE every
   * other middleware and route: loopback requests are untouched, and non-loopback
   * requests may reach only /tv, /tv.html, /stream and GET /api/observations, and
   * only with the shared secret. Absent (the default, and the server runtime's
   * choice — it has its own API-key auth) ⇒ nothing is mounted and behavior is
   * unchanged.
   */
  remoteReadOnly?: RemoteReadOnlyOptions;
  ```
- Mount it as the **first** statement after `this.app.disable('x-powered-by')` at `Server.ts:128`,
  i.e. above `setupSecurityHeaders()`:
  ```ts
  128: this.app.disable('x-powered-by');
  129: this.setupRemoteReadOnlyGuard();   // NEW — must precede everything (Phase 0.1)
  130: this.setupSecurityHeaders();
  ```
  with `private setupRemoteReadOnlyGuard(): void { if (!this.options.remoteReadOnly) return; this.app.use(createRemoteReadOnlyGuard(this.options.remoteReadOnly)); }`
  — copy the early-return shape from `setupSecurityHeaders` (`:198-206`).

`src/services/worker-service.ts` — in the `new Server({...})` call at `:273-297`, alongside the
existing `preBodyParserRoutes`:

```ts
      ...(tvToken ? { remoteReadOnly: { getToken: () => tvToken } } : {}),
```

Read `tvToken` per 1.2. Because the option is conditional, an install without a token constructs the
Server with an identical option object to today.

`src/server/runtime/ServerService.ts:129` — **do not touch.** That runtime has `requireServerAuth`
on `/v1/*` and `securityHeaders: true`; the TV guard is not its concern.

### 2.5 Startup log line

At `worker-service.ts` near the existing `await this.server.listen(port, host)` (`:420`), when a token
is configured, emit one `logger.info('SYSTEM', 'Observation TV remote broadcast enabled', { host, allowedPaths: [...] })`.
Operators need to see, in the log, that the surface is open. Do not log the token.

### 2.6 Tests — `tests/server/tv-remote-guard.test.ts`

Copy the skeleton from `tests/server/server-security-headers.test.ts:10-45`: `baseOptions()` factory,
`new Server(baseOptions({ remoteReadOnly: { getToken: () => 'secret' } }))`,
`await server.listen(41000 + Math.floor(Math.random()*9000), '127.0.0.1')`, `fetch`, `afterEach` close.

Loopback tests hit `127.0.0.1` directly. To exercise the *non-loopback* branch without a second NIC,
factor the decision out of the express plumbing:

```ts
export function decideRemoteAccess(input: {
  method: string; path: string; presentedToken: string | null; expectedToken: string;
}): { allow: true } | { allow: false; status: 403 | 404 | 401; reason: 'method'|'path'|'token' };
```

and have the middleware be a thin adapter over it. Unit-test `decideRemoteAccess` directly — this
mirrors how `assertServerRuntimeForCli` is tested as a pure function in
`tests/server/server-runtime-guard.test.ts:9-50`.

Required cases:

| # | Input | Expect |
|---|---|---|
| 1 | loopback `GET /api/settings`, no token | reaches the handler (loopback is never gated) |
| 2 | loopback `POST /api/admin/restart` | unchanged behavior — `requireLocalhost` still governs |
| 3 | remote `GET /tv` + correct `?token=` | allow |
| 4 | remote `GET /tv` + correct `Authorization: Bearer` | allow |
| 5 | remote `GET /tv` + correct `X-Api-Key` | allow |
| 6 | remote `GET /tv` + wrong token | 401 |
| 7 | remote `GET /tv` + **no** token | 401 |
| 8 | remote `GET /stream` + correct token | allow |
| 9 | remote `GET /api/observations` + correct token | allow |
| 10 | remote `GET /api/settings` + **correct** token | **404** ← the headline test |
| 11 | remote `GET /api/observations/by-file` + correct token | 404 (exact-match, not prefix) |
| 12 | remote `POST /api/admin/restart` + correct token | 403 (method gate fires before path) |
| 13 | remote `POST /api/settings` + correct token | 403 |
| 14 | remote `POST /api/observations/batch` + correct token | 403 |
| 15 | remote `GET /api/auth/session` + correct token | 404 |
| 16 | remote `GET /v1/info` + correct token | 404 |
| 17 | remote `GET /` and `/viewer.html` + correct token | 404 |
| 18 | remote `GET /restart` + correct token | 404 |
| 19 | remote `GET /api/logs` + correct token | 404 |
| 20 | remote `GET /health` + correct token | 404 (pid/platform disclosure) |
| 21 | `?token=` repeated (array) | 401, no crash |
| 22 | expected token `''` | `decideRemoteAccess` denies everything (guard should not be mounted, but must fail closed if it is) |
| 23 | loopback `req.ip` with `X-Forwarded-For: 1.2.3.4` present | treated as remote, not loopback |

### 2.7 Verification checklist — Phase 2

```bash
npm run typecheck
bun test tests/server/tv-remote-guard.test.ts
bun test tests/server/                                  # no regressions in the Server suite
grep -n "next(err\|next(error" src/services/worker/http/middleware.ts   # expect no hit inside the new guard
grep -rn "trust proxy" src/                             # expect 0 hits
grep -c "" <<< "$(git diff --stat)"                     # sanity: diff stays small
```

- [ ] All 23 cases green.
- [ ] With **no** token configured, `git stash`-free manual check: boot the worker, confirm
      `/api/settings` still answers on loopback and the constructed `ServerOptions` has no
      `remoteReadOnly` key.
- [ ] The guard never appears in the diff of any route file — it is mounted in exactly one place.

---

## Phase 3 — tv.html carries the token

**How this serves the primary goal:** without this, the page loads on the phone and then both of its
requests 401. Two lines of change.

### 3.1 The change

`src/ui/tv.html` already parses URL knobs (`?project=`, `?source=`, `?dwell=`, `?fade=`, `?seed=`,
`?replay=`). Add `token` to that same parsing block, then:

- `tv.html:265` — the seed fetch. Append `token` to the existing `qs` `URLSearchParams` when present.
- `tv.html:277` — `new EventSource('/stream')` → `new EventSource('/stream' + (token ? '?token=' + encodeURIComponent(token) : ''))`.

Nothing else. No new dependency, no auth UI, no localStorage of the secret (a bookmark holds it; a
stored secret outlives the intent).

The flow on the phone is: open `http://<lan-ip>:37700/tv.html?token=<secret>` — the page is served
because `/tv.html` is on the allowlist and the token is in the query, and the page then reuses the
same token for its two calls.

### 3.2 Rebuild the copy

`scripts/build-viewer.js:43-47` already copies `src/ui/tv.html` → `plugin/ui/tv.html` verbatim. Run
`npm run build-and-sync` (per CLAUDE.md) so `plugin/ui/tv.html` matches — the repo ships built plugin
artifacts and a stale bundle has bitten this project before (`4da9ffc6`, issue #3857).

### 3.3 Verification checklist — Phase 3

```bash
node --check <(sed -n '/<script>/,/<\/script>/p' src/ui/tv.html)   # the inline script parses
npm run build-and-sync
diff <(sed 's/\r$//' src/ui/tv.html) <(sed 's/\r$//' plugin/ui/tv.html) && echo "copies match"
grep -n "token" src/ui/tv.html                                     # knob parse + 2 call sites
```

- [ ] `src/ui/tv.html` and `plugin/ui/tv.html` are byte-identical.
- [ ] Loopback, **no** token configured: `http://127.0.0.1:37700/tv.html` still works with no `?token=`
      (the guard is not mounted). This is the regression that matters most — the local TV must not
      become harder to use.
- [ ] Loopback, token configured: `http://127.0.0.1:37700/tv.html` **still works without a token**
      (loopback is never gated).
- [ ] From a second device on the LAN with `CLAUDE_MEM_WORKER_HOST=0.0.0.0` and a token set:
      `http://<lan-ip>:<port>/tv.html?token=<secret>` renders cards and the SSE stream stays open.
- [ ] Same device, same URL, token removed ⇒ 401. Same device, `/` ⇒ 404. Same device,
      `/api/settings?token=<secret>` ⇒ 404 and **no API keys in the response body**. Capture this
      last one as a terminal transcript in the PR description.

---

## Phase 4 — Host bind, the boot warning, and the docs

**How this serves the primary goal:** the token is useless if nobody knows the two settings work as a
pair, and dangerous if someone opens the bind without it.

### 4.1 Do not change the default

`CLAUDE_MEM_WORKER_HOST` stays `127.0.0.1` (`SettingsDefaultsManager.ts:138`). The validation regex at
`SettingsRoutes.ts:180-186` already accepts `0.0.0.0` and specific IPs; leave it alone.

The four states, which belong verbatim in the docs:

| `CLAUDE_MEM_WORKER_HOST` | `CLAUDE_MEM_TV_TOKEN` | Result |
|---|---|---|
| `127.0.0.1` (default) | empty | Today. Nothing reachable off-box. **Recommended for everyone not using the TV remotely.** |
| `127.0.0.1` | set | Token is inert — nothing can reach the port anyway. Harmless. |
| `0.0.0.0` | **empty** | **Dangerous, and unchanged from today**: the full API — settings incl. provider API keys, deletes, import, better-auth — is on the LAN. This is what `docs/docker.md:12` already tells people to do, so we warn rather than break it. |
| `0.0.0.0` | set | The point of this plan. LAN devices reach `/tv`, `/tv.html`, `/stream`, `GET /api/observations` with the secret, and get 404/403/401 for everything else. |

State plainly, in the docs, the tradeoff the fourth row buys: the **React viewer at `/` stops working
remotely** when a token is set. That is intended — the viewer needs the write and settings routes the
guard denies. If someone wants the full viewer on another device, that is the Pro remote-hosting path
(Appendix A), not a wider allowlist.

### 4.2 Boot-time warning

At `worker-service.ts` next to the `listen` call (`:420`), after resolving `host` (`:403`):

- host is non-loopback **and** token empty ⇒
  `logger.warn('SECURITY', 'Worker bound to a non-loopback host with no CLAUDE_MEM_TV_TOKEN — the full worker API, including provider API keys via GET /api/settings, is reachable from the network', { host })`.
- **Warn; do not refuse to bind.** Refusing would break the documented Docker deployment
  (`docs/docker.md:12`) for people who have made their own network decisions. Copy the tone of the
  existing `logger.warn('SECURITY', ...)` at `middleware.ts:74-78`.

### 4.3 Docs

`docs/public/configuration.mdx` — add one row to the Core Settings table (`:14-24`), matching the
existing column format exactly:

```
| `CLAUDE_MEM_TV_TOKEN`         | —                               | Shared secret for Observation TV remote access. Empty = off. With a non-loopback `CLAUDE_MEM_WORKER_HOST`, only `/tv`, `/tv.html`, `/stream` and `GET /api/observations` are reachable, and only with this token. |
```

Then a short new section following the file's own convention (a `###` heading, a table, then a
"Manual Configuration" fenced `json` block — copy the shape at `:83-91`), containing: how to mint a
token, the four-state table from 4.1, the "viewer stops working remotely" tradeoff, and an explicit
"the token rides in the URL for `/stream` because `EventSource` cannot set headers; it is not written
to the worker log (`req.path` excludes the query string) but it *will* be in browser history — treat
the URL as the secret."

Also note in that section, honestly: **a LAN observer can still see the traffic.** This is plain HTTP.
The token stops an unauthenticated device from reading the stream; it does not encrypt it. Anyone who
can sniff the LAN sees observation titles. For the home-network case that is the accepted tradeoff;
for anything else, terminate TLS in front (out of scope here) — and still not a tunnel to the
unmodified worker.

### 4.4 Accepted risks — write these into the plan's PR description

1. **`GET /api/observations` returns full observation bodies** — `narrative`, `facts`, `text`,
   `files_read`, `files_modified`, for **every project on the box**, not just the TV's four fields.
   A token holder can page through the entire memory database with `offset`. Accepted for this slice
   because the token holder is the user's own device. **Follow-up (parked, not this slice):** a
   `fields=tv` projection, or a dedicated `GET /api/tv/observations` returning only
   `id, title, project, platform_source, created_at_epoch`. Deliberately not done now — it would add
   a route and a shape to maintain for a threat (a leaked token) the projection only narrows, not closes.
2. **`/stream` is unfiltered** — it carries every `new_observation` for every project on the box, plus
   `initial_load` (the project catalog) and `processing_status`. `SSEBroadcaster.broadcast`
   (`src/services/worker/SSEBroadcaster.ts:24-38`) writes one payload to every client with no
   per-client filter; adding one means either a second broadcaster or a per-client predicate. Out of
   scope. The TV's `?project=` / `?source=` filters are client-side only — say so in the docs so
   nobody mistakes them for access control.
3. **No rate limiting.** A token holder can hammer `/api/observations`. There is no HTTP limiter in
   the codebase to reuse (0.4). Accepted.
4. **The token is readable on loopback** via `GET /api/settings` (1.3).

### 4.5 Verification checklist — Phase 4

- [ ] Boot with `CLAUDE_MEM_WORKER_HOST=0.0.0.0` and no token ⇒ the SECURITY warn appears in
      `npm run worker:logs`, and the worker **still binds**.
- [ ] Boot with default host ⇒ no warning, no behavior change.
- [ ] `docs/public/configuration.mdx` renders (Mintlify table syntax; check the pipe count matches
      neighbouring rows).
- [ ] The docs contain the four-state table and all four accepted risks.
- [ ] `grep -rn "cloudflared\|ngrok" docs/ plans/2026-09-05-observation-tv-readonly-broadcast.md`
      finds them only as *rejected* options, never as instructions.

---

## Phase 5 — (adjacent, small) `platform_source` on the card

**Fits cleanly — keep it.** This is STATUS.md open question 2, and it is genuinely small because the
field already exists end to end: `platform_source` is on `ObservationSSEPayload`
(`src/services/worker/agents/types.ts:13,31`) and already comes back from `/api/observations`. No
worker change, no schema change, no new route. `src/ui/tv.html` only.

**How this serves the primary goal:** with several agents fanning into one `/stream`, a card that says
only *what* happened but not *who* reads as noise. Attribution is what makes the TV legible.

### 5.1 The change

`src/ui/tv.html` only:
- Render `observation.platform_source` as a small label beside the existing `project` label.
- Derive a stable per-source accent colour. Use the canonical vocabulary from
  `src/shared/platform-source.ts`: `DEFAULT_PLATFORM_SOURCE = 'claude'` (`:1`), and
  `normalizePlatformSource` collapses inputs to `claude` / `codex` / `cursor` / passthrough (`:7-19`).
  `sortPlatformSources` (`:26-39`) gives the display priority `claude, codex, cursor, …alphabetical`.
  Do **not** re-derive that mapping in the HTML — mirror those three names and hash anything else to a hue.
- Both render paths must be updated: the Document-PiP DOM path *and* the canvas path
  (`captureStream()`), which paints text manually. A change to only one silently regresses iOS.

### 5.2 Verification checklist — Phase 5

- [ ] Cards show `project` + `platform_source`; a `claude` card and a `cursor` card differ visibly.
- [ ] The canvas/PiP path shows the label too (open PiP with `p` and confirm).
- [ ] Unknown source (e.g. `grok-bot`) renders with a derived colour, not blank and not a crash.
- [ ] `node --check` on the inline script; `npm run build-and-sync`; the two `tv.html` copies match.
- [ ] No change outside `src/ui/tv.html` and `plugin/ui/tv.html`.

**Parked, explicitly not this slice** (STATUS.md open questions 3 and 4): pacing under burst load
(shrink dwell when the live queue is deep) and worker-side short titles. Both are TV-quality work
with no security content; they do not belong in a slice whose job is the boundary.

---

## Phase 6 — Final verification

Run in a fresh context with no assumptions carried from earlier phases.

### 6.1 Prove the boundary, not the code

Boot a worker with `CLAUDE_MEM_WORKER_HOST=0.0.0.0` and a real token, then from a **second machine**
(not the worker's own box — a curl to `127.0.0.1` proves nothing, it takes the loopback branch):

```bash
LAN=http://<worker-lan-ip>:<port>
T='<token>'

# MUST succeed
curl -sf "$LAN/tv.html?token=$T"        > /dev/null && echo "OK  tv.html"
curl -sf "$LAN/tv?token=$T"             > /dev/null && echo "OK  /tv"
curl -sf "$LAN/api/observations?limit=5&token=$T" | head -c 200
curl -sN  "$LAN/stream?token=$T"        | head -c 200        # expect: data: {"type":"connected"...
curl -sf -H "Authorization: Bearer $T" "$LAN/api/observations?limit=1" > /dev/null && echo "OK  bearer"

# MUST fail — and the settings one must show NO api keys
curl -si "$LAN/api/settings?token=$T"          | head -1     # expect 404
curl -si "$LAN/api/settings?token=$T"          | grep -ci "api_key\|apikey\|sk-\|OPENROUTER"   # expect 0
curl -si -X POST "$LAN/api/admin/restart?token=$T" | head -1 # expect 403
curl -si -X POST "$LAN/api/settings?token=$T"  | head -1     # expect 403
curl -si -X DELETE "$LAN/api/observation/1?token=$T" | head -1 # expect 403
curl -si "$LAN/?token=$T"                      | head -1     # expect 404
curl -si "$LAN/health?token=$T"                | head -1     # expect 404
curl -si "$LAN/api/auth/session?token=$T"      | head -1     # expect 404
curl -si "$LAN/v1/info?token=$T"               | head -1     # expect 404
curl -si "$LAN/api/logs?token=$T"              | head -1     # expect 404
curl -si "$LAN/tv.html"                        | head -1     # expect 401 (no token)
curl -si "$LAN/tv.html?token=wrong"            | head -1     # expect 401
```

**And confirm the worker is still alive after all of that** — `curl -sf $LAN/tv?token=$T` — which
proves the `POST /api/admin/restart` above really was refused rather than merely returning an error
after restarting.

### 6.2 Prove nothing regressed for the default install

With **no** token and the default host:

```bash
npm run typecheck
bun test tests                      # full suite
curl -sf http://127.0.0.1:$PORT/api/settings   > /dev/null && echo "OK  loopback settings"
curl -sf http://127.0.0.1:$PORT/tv.html        > /dev/null && echo "OK  loopback tv"
curl -sN http://127.0.0.1:$PORT/stream | head -c 60
```

### 6.3 Anti-pattern grep

```bash
# no new dependency
git diff main -- package.json | grep -E '^\+.*"(helmet|express-rate-limit|passport|jsonwebtoken|cors)"' && echo "FAIL: dependency added"

# guard is mounted in exactly one place
grep -rn "createRemoteReadOnlyGuard" src/ | tee /dev/stderr | wc -l    # expect 3: definition, import, one app.use

# no denylist crept in
grep -rniE "denyl(ist)?|blockl(ist)?|blacklist" src/services/worker/http/middleware.ts   # expect 0

# no prefix matching in the allowlist
grep -n "startsWith\|RegExp\|\.test(" src/services/worker/http/middleware.ts | grep -i "path"  # expect 0 in the guard

# constant-time compare, not ===
grep -n "timingSafeEqual" src/services/worker/http/middleware.ts       # expect >= 1

# token never logged
grep -rn "token" src/services/worker/http/middleware.ts | grep -i "logger"   # expect 0

# trust proxy never introduced
grep -rn "trust proxy" src/                                            # expect 0

# tunnels are not a solution
grep -rn "cloudflared\|ngrok" src/                                     # expect 0
```

### 6.4 Sign-off

- [ ] Every 6.1 line produced its expected status, run from a genuinely different machine.
- [ ] `bun test tests` green.
- [ ] `npm run typecheck` green.
- [ ] All 6.3 greps produced their expected counts.
- [ ] `src/ui/tv.html` and `plugin/ui/tv.html` byte-identical; `npm run build-and-sync` clean.
- [ ] The four accepted risks (4.4) appear in the PR description, not only in this file.

---

## Appendix A — Release shape: OSS vs Pro

Not a build. One paragraph so the boundary is decided before someone has to guess.

**Everything in this plan ships OSS.** It is ~4 files: one guard in `middleware.ts`, one option on
`Server`, one setting, two lines in `tv.html`. It makes an existing OSS feature usable on a second
screen and, incidentally, closes a real footgun — anyone who has ever set `CLAUDE_MEM_WORKER_HOST=0.0.0.0`
(which `docs/docker.md:12` tells them to) is currently serving their provider API keys to their
network. A security improvement is not a paid feature.

**What is Pro-shaped, and is explicitly NOT this slice:** anything that puts observations on a device
*not on the same LAN*. That needs an identity story (better-auth is already mounted at
`/api/auth/*splat`, `BetterAuthRoutes.ts:31`, and `requireServerAuth` + `sqlite-api-key-service`
already implement scoped keys — `src/server/middleware/auth.ts:35-95`), a relay the worker dials
*out* to rather than a port it opens *in*, and TLS. The existing cloud-sync path
(`CLAUDE_MEM_CLOUD_SYNC_HUB_URL` + `CLAUDE_MEM_CLOUD_SYNC_TOKEN`, `worker-service.ts:528-534`) is the
right shape to extend: outbound, authenticated, already built. A shared secret on a LAN port is the
right answer for "my phone on my desk"; it is the wrong answer for "my phone at the airport", and the
temptation to widen this allowlist until it becomes the second thing is the failure mode to guard
against. When that day comes it is a new plan, not more paths in `REMOTE_READABLE_PATHS`.

---

## Appendix B — Rejected, with reasons (do not re-propose)

| Option | Why not |
|---|---|
| `cloudflared tunnel --url http://127.0.0.1:PORT` | Publishes `POST /api/admin/restart`, `POST /api/settings`, `GET /api/settings` (provider API keys), `DELETE /api/observation/:id`, `POST /api/import` and better-auth to the open internet. Rejected by decision 2026-09-05. |
| Reuse `requireServerAuth` / better-auth for the TV | DB-backed and scope-based; needs the DB open, but the TV must render during the init window when `worker-service.ts:328-351` answers 503 for `/api/*`. Also cannot authenticate an `EventSource`. Right answer for Pro (Appendix A), wrong for this. |
| Denylist of dangerous routes | 45+ routes across 13 classes, growing. The next route added is remote-readable by default. |
| Mount the guard in `ViewerRoutes.setupRoutes` | Too late: `express.static(plugin/ui)` (`middleware.ts:36`), `/api/auth/*` and `/api/admin/*` are all mounted before it (0.1). |
| `express-rate-limit` / helmet / passport | New dependency; the repo declined helmet on record (`Server.ts:96-105`) and hand-rolled instead. |
| Reuse `globalRateLimitStore` or `src/server/middleware/rate-limit.ts` | The first tracks LLM provider quota; the second is Postgres-backed Server-Beta only (0.4). |
| Refuse to bind when host is non-loopback and no token | Breaks the documented Docker deployment (`docs/docker.md:12`) for people who made their own network call. Warn loudly instead (4.2). |
| Change the `CLAUDE_MEM_WORKER_HOST` default to `0.0.0.0` | Would silently expose every existing install on upgrade. |
| Put the token in the settings UI / `settingKeys` | `POST /api/settings` is unauthenticated; any page the user visits could then set a token of its choosing (1.3). |
| A second SSE broadcaster to filter `/stream` per client | Real work for marginal gain in a slice whose job is the boundary. Parked (4.4 risk 2). |
| OBS / ffmpeg / canvas recording | Already rejected in the thin slice. A page plus browser PiP does the job. |
