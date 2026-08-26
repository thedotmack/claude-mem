# EAT — Extract, Analyze, Transform: Universal Ingester for claude-mem

**EAT** is claude-mem's universal data ingester. The name is a reordering of ETL that spells what it does: it **E**xtracts whatever you feed it (files, URLs, feeds, stdin payloads, MCP connectors), **A**nalyzes what it is (auto mode — no flags needed), and **T**ransforms it into claude-mem observations. It eats data and digests it into memory.

Ergonomics are modeled on memorable.sh (`memorable ingest <trace.json | ->`): one universal verb, file-or-stdin-or-URL, auto by default, `request_id` on every API response, uniform `{error, detail}` errors. Digestion uses the **Vercel AI SDK v7** (`generateText` + `Output.object()` with zod), with **MCP connectors** via `@ai-sdk/mcp` `createMCPClient` as the pluggable-source mechanism.

Execution note: run phases in order; each phase is self-contained with its own doc references. All paths relative to repo root. House style applies: NO try/catch until Phase 6 (fail fast), relative imports carry `.js` extensions, ESM throughout.

---

## Phase 0: Consolidated Documentation Findings (COMPLETE — reference only)

### 0.1 Allowed APIs — Vercel AI SDK v7 (verified against installed `ai@7.0.82` bundled docs + `.d.ts`)

Packages to add as **devDependencies** (esbuild inlines them, same as `@anthropic-ai/claude-agent-sdk` — see the `//dependencies-note` at `package.json:160`):

| Package | Version | Use |
|---|---|---|
| `ai` | ^7.0.82 | `generateText`, `Output`, `tool`, `embed`, `gateway` |
| `@ai-sdk/mcp` | ^2.0.39 | `createMCPClient` (connector mode) |
| `@openrouter/ai-sdk-provider` | ^3.0.0 | OpenRouter provider (3.x line = ai v7 compatible) |
| `zod` | ^4 | schemas (check if already present in package.json first; reuse existing version if so) |

**Structured extraction — the ONLY sanctioned digest call shape** (from `ai@7` docs `03-ai-sdk-core/10-generating-structured-data.mdx`):

```ts
import { generateText, Output } from 'ai';
import { z } from 'zod';

const { output } = await generateText({
  model,                       // LanguageModel from provider, or gateway string
  output: Output.object({ schema: z.object({ ... }) }),
  prompt: '...',
  maxOutputTokens: 8_000,      // NOT maxTokens
});
// result is on `output`
```

**Provider selection**:
```ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
const openrouter = createOpenRouter({ apiKey });   // key from claude-mem credentials, see 0.3
const model = openrouter('anthropic/claude-haiku-4.5');
// Fallback path: AI Gateway — plain string model: 'anthropic/claude-haiku-4.5' with AI_GATEWAY_API_KEY env
```

**MCP connector client** (from `ai@7` docs `03-ai-sdk-core/16-mcp-tools.mdx`):
```ts
import { createMCPClient } from '@ai-sdk/mcp';
const mcpClient = await createMCPClient({
  transport: { type: 'http', url, headers },
});
const resources = await mcpClient.listResources();
const content = await mcpClient.readResource({ uri });
await mcpClient.close();
```

**ANTI-PATTERNS — these do NOT exist / are deprecated in v7. Never write them:**
- `generateObject` / `streamObject` — deprecated; use `generateText` + `Output.object()`
- `experimental_createMCPClient` from `'ai'` — gone; `createMCPClient` lives in `@ai-sdk/mcp`
- `parameters:` in `tool()` — it's `inputSchema:`
- `maxTokens` — it's `maxOutputTokens`
- `system:` — it's `instructions:` in v7
- `stepCountIs` — it's `isStepCount`; `maxSteps` is long gone
- `experimental_output`, `experimental_telemetry`, `onFinish`/`onStepFinish` — renamed (`output`, `telemetry`, `onEnd`/`onStepEnd`)
- CommonJS imports of `ai` — v7 is ESM-only (repo is ESM, fine)

### 0.2 memorable.sh patterns being copied

- **One universal verb**: `memorable ingest <trace.json | ->` → ours: `claude-mem eat <file|url|-> [flags]`. Auto-detection is the default; there is no "mode flag soup."
- **API conventions**: every response body carries `request_id`; errors are uniform `{error: "<code>", detail?: "..."}` with codes like `invalid_request`, `payload_too_large` (>8 MB), `rate_limited`. Partial failure degrades gracefully (memorable returns empty `embedding` + `embedding_error` rather than failing the request).
- **Dry-run / JSON output**: `--dry-run` previews drafts without writing; `--json` for machine output; human-readable default.
- **Local reject log**: memorable keeps `~/.memorable/rejected.jsonl` — we keep `~/.claude-mem/eat-rejected.jsonl` for chunks the model refused/failed to digest.

### 0.3 claude-mem integration points (exact, line-verified)

- **npx CLI dispatch**: plain `switch (command)` at `src/npx-cli/index.ts:96–234`. Insert `case 'eat'` at `src/npx-cli/index.ts:215` (after `cleanup`, before `case 'transcript'` at `:216`), copying the `transcript` case idiom at `:216–227` (lazy `await import('./commands/eat.js')`). Help text block: `src/npx-cli/index.ts:39–50`.
- **worker-service CLI dispatch**: `switch (command)` at `src/services/worker-service.ts:1082`. Insert `case 'eat'` at `:1367` (between `transcript` ending `:1366` and `adopt` at `:1368`), copying `:1356–1366`.
- **Route registration**: `WorkerService.registerRoutes()` at `src/services/worker-service.ts:315–364`; register `EatRoutes` alongside `MemoryRoutes` at `:363`.
- **The write recipe to copy verbatim**: `src/services/worker/http/routes/MemoryRoutes.ts:28–103` — `getOrCreateManualSession(project)` → observation literal → `sessionStore.storeObservation(...)` → `dbManager.getCloudSync()?.notify()` → `chromaSync.syncObservation(...)` → JSON response. Route class boilerplate: `MemoryRoutes.ts:1–26` + `BaseRouteHandler.ts:8–23` (`wrapHandler`) + `src/services/worker/http/middleware/validateBody.ts` (zod validation).
- **Storage API** (never write raw SQL): `SessionStore.storeObservations(memorySessionId, project, observations[], summary|null, promptNumber?, discoveryTokens?, overrideTimestampEpoch?, generatedByModel?)` at `src/services/sqlite/SessionStore.ts:2589` (transactional, content-hash deduped); `getOrCreateManualSession(project)` at `:2986`.
- **Observation `type` values MUST come from the active mode**: `ModeManager.getInstance().getActiveMode()` (`src/services/domain/ModeManager.ts:10`), types in `plugin/modes/code.json` → `observation_types`. `MemoryRoutes.ts:44` shows the fallback convention (`'discovery'` — "Use existing valid type").
- **Settings**: add keys to BOTH the `SettingsDefaults` interface (`src/shared/SettingsDefaultsManager.ts:22`) and `DEFAULTS` (`:117`). Load via `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)`.
- **Credentials**: `getCredential('OPENROUTER_API_KEY')` from `src/shared/EnvManager.ts:297`; settings key `CLAUDE_MEM_OPENROUTER_API_KEY` resolution pattern at `src/services/worker/OpenRouterProvider.ts:414–435`.
- **URL fetching**: `fetchWithTimeout(url, init, timeoutMs)` at `src/shared/worker-utils.ts:52`. **No generic content fetcher, chunker, or mime detection exists in the repo — those are net-new in Phase 2.**
- **Size limiting precedent**: `OBS_PROMPT_FIELD_MAX_CHARS = 16_000` and `truncateObservationField` at `src/sdk/prompts.ts:103–119`.
- **CLI→worker HTTP client pattern**: `src/npx-cli/commands/runtime.ts:158–198` (health probe, POST, friendly ECONNREFUSED handling); `ensureWorkerRunning()` at `src/shared/worker-utils.ts:454`; `buildWorkerUrl(apiPath)` at `:172`.
- **Iterate-and-ingest analogue**: `src/services/transcripts/processor.ts:28–38` and `cli.ts:1–65` (subcommand router returning exit codes).
- **Name collision check**: nothing named `eat` exists anywhere in the repo. `ingest`/`import` exist but are scoped (tool-event ingest; raw record round-trip) — no overlap.
- **Tests**: `bun test tests` (253 test files under `tests/`, mirroring `src/`). New tests go in `tests/eat/`.
- **Build**: EAT's worker code rides inside the existing `worker-service.cjs` bundle (no new entry point in `scripts/build-hooks.js` needed). The npx `eat` command file must be emitted by the npx-cli build — verify `scripts/build-hooks.js:609–614` bundles/emits `src/npx-cli/commands/*` and mirror whatever the `transcript` command does.

---

## Phase 1: Dependencies, settings, and types

**What to implement:**
1. Add to `package.json` devDependencies: `ai@^7.0.82`, `@ai-sdk/mcp@^2.0.39`, `@openrouter/ai-sdk-provider@^3.0.0`. Check whether `zod` already exists (worker routes already use it via `validateBody`); reuse the existing version, do not add a duplicate. Run `bun install`.
2. Add settings keys — edit BOTH `src/shared/SettingsDefaultsManager.ts:22` (interface) and `:117` (`DEFAULTS`), following the comment discipline at `:9`:
   - `CLAUDE_MEM_EAT_MODEL: string` — default `'anthropic/claude-haiku-4.5'` (OpenRouter slug)
   - `CLAUDE_MEM_EAT_MAX_CHUNK_CHARS: string` — default `'12000'` (stays under the 16k prompt-field precedent)
   - `CLAUDE_MEM_EAT_FETCH_TIMEOUT_MS: string` — default `'30000'`
3. Create `src/services/worker/eat/types.ts` with the shared shapes:
   ```ts
   export type EatSourceKind = 'file' | 'directory' | 'url' | 'feed' | 'stdin' | 'text' | 'mcp';
   export interface EatSource { kind: EatSourceKind; locator: string; contentType?: string }
   export interface EatChunk { index: number; text: string; source: EatSource }
   export interface EatDigestResult { observations: EatObservationDraft[]; model: string }
   export interface EatObservationDraft { type: string; title: string; subtitle: string; facts: string[]; narrative: string; concepts: string[] }
   export interface EatReport { request_id: string; source: EatSource; chunks: number; observation_ids: number[]; drafts?: EatObservationDraft[]; rejected: number }
   ```

**Documentation references:** `package.json:160` (dependencies-note comment — why devDeps), `src/shared/SettingsDefaultsManager.ts:9,22,117`.

**Verification checklist:**
- `bun install` exits 0; `bun -e "import('ai').then(m => console.log(typeof m.generateText, typeof m.Output))"` prints `function object`.
- `npm run typecheck` passes.
- `grep -n "CLAUDE_MEM_EAT" src/shared/SettingsDefaultsManager.ts` shows each key exactly twice (interface + DEFAULTS).

**Anti-pattern guards:** Do not add packages to `dependencies` (they must be inlined by esbuild — devDeps only, per `package.json:160`). Do not pin `@openrouter/ai-sdk-provider@^2` (that's the ai-v6 line).

---

## Phase 2: EAT core engine — detect, extract, chunk, digest

**What to implement** — new directory `src/services/worker/eat/` (all ESM, `.js` import extensions, NO try/catch — errors must surface):

1. **`detect.ts`** — `export function detectSource(input: string | undefined, hasStdin: boolean): EatSource`. Auto-mode rules, checked in order:
   - `input === '-'` or (`input` undefined and `hasStdin`) → `stdin`
   - `/^https?:\/\//.test(input)` → `url` (refined to `feed` in extract if content-type/body is RSS/Atom XML)
   - `existsSync(input)` and `statSync(input).isDirectory()` → `directory`
   - `existsSync(input)` → `file`
   - otherwise → `text` (the argument itself is the payload)
2. **`extract.ts`** — `export async function extractItems(source: EatSource, opts): Promise<Array<{ text: string; source: EatSource }>>`. One extractor per kind:
   - `file`: `readFileSync(path, 'utf-8')`; skip binary (NUL-byte sniff on first 8KB → push to reject log in Phase 6, for now just skip with a returned skip count)
   - `directory`: non-recursive by default; iterate entries, delegate to `file` (one item per file). `--recursive` flag plumbs through later from CLI.
   - `url`: `fetchWithTimeout` (copy from `src/shared/worker-utils.ts:52`) with `CLAUDE_MEM_EAT_FETCH_TIMEOUT_MS`; if content-type is HTML, strip tags/scripts/styles to text (small hand-rolled regex-free strip using a state pass — no new dependency); if `application/json` keep raw JSON text; if `xml` containing `<rss`/`<feed` → treat as `feed`
   - `feed`: parse `<item>`/`<entry>` blocks (title, link, description/content) with a minimal hand-rolled parser — one extracted item per feed entry, NO new dependency
   - `stdin`: read all of stdin as text
   - `text`: pass through
   - `mcp`: deferred to Phase 5
3. **`chunk.ts`** — `export function chunkText(text: string, maxChars: number): string[]`. Net-new (Phase 0 confirmed no chunker exists): split on paragraph boundaries (`\n\n`), greedily pack up to `maxChars`; a single oversized paragraph is hard-split. Deterministic, no LLM.
4. **`digest.ts`** — the Analyze+Transform step:
   - `export function buildEatModel(settings): LanguageModel` — resolve API key exactly as `src/services/worker/OpenRouterProvider.ts:414–435` does (`settings.CLAUDE_MEM_OPENROUTER_API_KEY || getCredential('OPENROUTER_API_KEY')`), then `createOpenRouter({ apiKey })(settings.CLAUDE_MEM_EAT_MODEL)`. If no OpenRouter key but `AI_GATEWAY_API_KEY` is set, return the plain gateway string `settings.CLAUDE_MEM_EAT_MODEL`.
   - `export async function digestChunk(chunk: EatChunk, modeTypes: string[], model): Promise<EatDigestResult>` — the exact v7 call from Phase 0.1: `generateText` + `Output.object({ schema })` where the zod schema is `z.object({ observations: z.array(z.object({ type: z.enum(modeTypes as [string, ...string[]]), title: z.string(), subtitle: z.string(), facts: z.array(z.string()), narrative: z.string(), concepts: z.array(z.string()) })) })`. `modeTypes` come from `ModeManager.getInstance().getActiveMode().observation_types` ids — NEVER hardcoded. Prompt: a short instruction ("You are EAT, claude-mem's ingester. Extract durable, useful observations from this content. Source: <locator>.") + the chunk text.
5. **`pipeline.ts`** — `export async function runEatPipeline(input, opts): Promise<EatReport>` — detect → extract → chunk each item → digest each chunk sequentially → return drafts (storage happens in Phase 3's route; the pipeline itself is storage-free so `--dry-run` is trivial).

**Documentation references:** Phase 0.1 snippets (the ONLY sanctioned AI SDK shapes); `src/shared/worker-utils.ts:52`; `src/services/worker/OpenRouterProvider.ts:414–435`; `src/services/domain/ModeManager.ts:10`; `src/sdk/prompts.ts:103–119` (size precedent).

**Verification checklist:**
- `bun test tests/eat/detect.test.ts tests/eat/chunk.test.ts` — write unit tests for `detectSource` (each rule) and `chunkText` (packing, oversized paragraph, empty input) in this phase; they pass.
- `npm run typecheck` passes.
- `grep -rn "generateObject\|streamObject\|experimental_createMCPClient\|maxTokens\b\|parameters:" src/services/worker/eat/` → no matches.

**Anti-pattern guards:** Everything in Phase 0.1's anti-pattern list. No try/catch. No new npm dependency for HTML/feed parsing (YAGNI — hand-rolled minimal parsing). No raw SQL. Do not call the Claude Agent SDK here — EAT digests via the Vercel AI SDK by design.

---

## Phase 3: Worker HTTP API — `POST /api/eat` (memorable-style)

**What to implement:**
1. `src/services/worker/http/routes/EatRoutes.ts` — copy the class shape from `MemoryRoutes.ts:1–26` (BaseRouteHandler + `wrapHandler` + `validateBody` zod). One endpoint:
   - **`POST /api/eat`** — body schema (zod, `.strict()`): `{ input?: string, content?: string, project: string, dry_run?: boolean, recursive?: boolean }`. Exactly one of `input` (path/URL/text) or `content` (raw payload, plays the stdin role over HTTP) must be present → else memorable-style `400 { error: 'invalid_request', detail: '...' }`.
   - Handler: generate a `request_id` (`crypto.randomUUID()`), run `runEatPipeline`, then unless `dry_run`: `getOrCreateManualSession(project)` → map each `EatObservationDraft` to the `storeObservations` shape (`files_read`: [locator] when source kind is `file`, else `[]`; `files_modified: []`; `metadata: JSON.stringify({ eat: true, source })`) → `sessionStore.storeObservations(...)` with `generatedByModel` set to the EAT model id → `dbManager.getCloudSync()?.notify()` → `chromaSync.syncObservation(...)` per stored id — copying `MemoryRoutes.ts:41–94` step-for-step.
   - Response 200: the `EatReport` (`request_id`, `source`, `chunks`, `observation_ids`, `rejected`, plus `drafts` when `dry_run`). Payloads >8 MB → `413 { error: 'payload_too_large' }` (memorable convention).
2. Register in `WorkerService.registerRoutes()` at `src/services/worker-service.ts:363`, adjacent to `MemoryRoutes`.

**Documentation references:** `MemoryRoutes.ts` (whole file), `BaseRouteHandler.ts:8–23`, `validateBody.ts`, `SessionStore.ts:2589,2986`, Phase 0.2 (memorable API conventions).

**Verification checklist:**
- `tests/eat/routes.test.ts`: schema rejects both-missing and both-present `input`/`content`; dry_run returns drafts and writes nothing.
- Manual smoke: `npm run build-and-sync`, then `curl -s -X POST http://127.0.0.1:$PORT/api/eat -H 'content-type: application/json' -d '{"content":"Bun 1.2 shipped native S3 support...","project":"claude-mem","dry_run":true}'` returns a JSON report with `request_id` and non-empty `drafts`.
- `npm run typecheck` passes.

**Anti-pattern guards:** No new tables, no raw SQL, no writes outside `storeObservations`. Observation `type` values only from the active mode. Do not invent extra endpoints (status/list — YAGNI; `--dry-run` is the preview).

---

## Phase 4: CLI — `claude-mem eat <file|url|-> ` (auto mode)

**What to implement:**
1. `src/npx-cli/commands/eat.ts` — `export async function runEatCommand(args: string[]): Promise<number>`. Modeled on memorable's `ingest`:
   - Usage: `claude-mem eat <file|url|-|text> [--project <name>] [--dry-run] [--json] [--recursive]`
   - No positional arg + piped stdin (`!process.stdin.isTTY`) → read stdin (the `-` convention also works explicitly).
   - Default `--project`: current directory basename (matching how the rest of claude-mem derives project).
   - Client work: `ensureWorkerRunning()` → read file/stdin content client-side when the source is local (send as `content` with the locator noted), pass URLs/text through as `input` → `POST /api/eat` via the fetch pattern in `src/npx-cli/commands/runtime.ts:158–198` (friendly ECONNREFUSED message).
   - Output: human-readable summary by default (`🍽  EAT digested 3 chunks from README.md → 5 observations (2 rejected)`); `--json` prints the raw `EatReport`.
2. Register `case 'eat'` in `src/npx-cli/index.ts` at `:215` (copy the `transcript` case at `:216–227`) and add a help line in the Runtime Commands block at `:39–50`: `eat <file|url|->   Digest anything into memory (EAT: Extract, Analyze, Transform)`.
3. Register `case 'eat'` in `src/services/worker-service.ts` at `:1367` (copy `:1356–1366`), delegating to the same command module so `bun plugin/scripts/worker-service.cjs eat …` works too.
4. Confirm the npx-cli build emits the new command file (check how `scripts/build-hooks.js:609–614` handles `src/npx-cli/commands/*`; mirror whatever `transcript` does).

**Documentation references:** `src/npx-cli/index.ts:96–234`, `src/services/transcripts/cli.ts:1–65` (arg parsing helper `getArgValue`), `src/npx-cli/commands/runtime.ts:158–198`, Phase 0.2 (memorable CLI ergonomics).

**Verification checklist:**
- `npm run build-and-sync` succeeds.
- `echo "The worker restarts via npm run worker:restart inside the marketplace dir" | npx claude-mem eat - --dry-run --json` prints an `EatReport` with drafts.
- `npx claude-mem eat README.md --dry-run` prints a human summary.
- `npx claude-mem eat https://example.com --dry-run` fetches and digests.
- `npx claude-mem eat` with no args and no stdin prints usage and exits 1.

**Anti-pattern guards:** No commander/yargs (repo convention is hand-rolled dispatch). Keep the command a thin worker client — no direct DB access from the CLI process.

---

## Phase 5: Connector mode — `eat mcp <url>` (Vercel AI SDK connectors)

This is the "Vercel connectors" ask, mapped to the real API: the AI SDK's connector mechanism is `createMCPClient` from `@ai-sdk/mcp` (Phase 0.1 — `experimental_createMCPClient` from `'ai'` no longer exists).

**What to implement:**
1. `src/services/worker/eat/connectors.ts` — `export async function extractFromMcp(url: string, opts: { resource?: string; header?: string[] }): Promise<Array<{ text; source }>>`:
   - `createMCPClient({ transport: { type: 'http', url, headers } })` (headers from repeated `--header 'K: V'` flags — this is where a Vercel Connect `getToken()` bearer would slot in, but we do NOT add `@vercel/connect` — YAGNI, it needs a Vercel team + OIDC).
   - `--resource <uri>` given → `readResource({ uri })`; otherwise `listResources()` and read each. Text/JSON contents become extract items; close the client in a `finally`-free straight line (call `close()` after the reads — error handling comes in Phase 6).
2. Wire into `detect.ts`/`pipeline.ts`: CLI subcommand `claude-mem eat mcp <url> [--resource <uri>] [--header <h>]...` sets `source.kind = 'mcp'` explicitly (connectors are declared, not sniffed — same philosophy as memorable's self-declared `harness` field). Extend the `/api/eat` body schema with optional `mcp: { url, resource?, headers? }`.

**Documentation references:** Phase 0.1 MCP snippet; `@ai-sdk/mcp` docs (`ai@7` bundled `03-ai-sdk-core/16-mcp-tools.mdx`).

**Verification checklist:**
- `tests/eat/connectors.test.ts` with a stub HTTP MCP server (or mock of `createMCPClient`) covering list-then-read and single-resource paths.
- `grep -rn "experimental_createMCPClient" src/` → no matches.
- `npm run typecheck` passes.

**Anti-pattern guards:** Import `createMCPClient` ONLY from `@ai-sdk/mcp`. Do not add `@vercel/connect`. HTTP transport `redirect` defaults to `'error'` in v7 (SSRF protection) — leave the default.

---

## Phase 6: Error handling, reject log, and final verification

Happy path is established — NOW add structured error handling (house rule: phased error handling).

**What to implement:**
1. Error boundaries at the right seams: `extract.ts` per-item (a failed URL/file becomes a rejected item, not a crashed run), `digest.ts` per-chunk (model/schema failure → chunk goes to the reject log with the reason; run continues — memorable's graceful-degradation convention), `EatRoutes` top level (map failures to memorable-style codes: `invalid_request`, `payload_too_large`, `upstream_fetch_failed`, `digest_failed`; always include `request_id`).
2. Reject log: append `{ ts, request_id, source, reason, chunk_index }` lines to `~/.claude-mem/eat-rejected.jsonl` (path built from the data dir helper in `src/shared/paths.ts:20`). Surface `rejected` count in `EatReport` and the CLI summary.
3. Provider outage handling: no API key resolvable → clean CLI error naming the two settings (`CLAUDE_MEM_OPENROUTER_API_KEY` credential or `AI_GATEWAY_API_KEY`), exit 1. (Relevant today: the observer's OpenRouter allowance is exhausted — EAT must fail loudly and legibly, not hang.)

**Final verification (whole feature):**
- `bun test tests/eat` — all green.
- `npm run typecheck` — clean.
- Anti-pattern sweep: `grep -rn "generateObject\|streamObject\|experimental_createMCPClient\|maxTokens\b\|parameters: z\.\|stepCountIs" src/services/worker/eat/ src/npx-cli/commands/eat.ts src/services/worker/http/routes/EatRoutes.ts` → zero matches.
- Convention sweeps that existing tests enforce: `bun test tests/logger-usage-standards.test.ts tests/session_id_usage_validation.test.ts`.
- `npm run build-and-sync` → then end-to-end: `npx claude-mem eat README.md --project claude-mem` stores observations (verify via `curl http://127.0.0.1:$PORT/api/observations?project=claude-mem` or the viewer) and they carry `metadata.eat = true` and a mode-valid `type`.
- `bun test tests` full suite — no regressions.

---

## Out of scope (explicitly, YAGNI)

- Server runtime (`memory_items` / `POST /v1/memories`) support — worker runtime only.
- Scheduled/watch mode, batch queueing endpoints, embeddings, dedup beyond `storeObservations`' content-hash, `@vercel/connect` OAuth plumbing, new npm deps for HTML/RSS parsing, an MCP tool exposure of EAT.
- Docs site page (`docs/public/`) — do after the feature is proven, if asked.
