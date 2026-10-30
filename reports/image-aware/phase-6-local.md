# Phase 6 handoff (L): local viewer, feed normalization, gateway correlation, privacy copy

Repository L, branch `feat/image-aware-observations`, on top of HEAD `22a2a1853`
(Phases 1, 2, 4 and 5 committed). **Nothing is committed.** No production
database, bucket, Pro deployment or paid model call was touched. The frozen
contract (`docs/media-contract-v1.md`, `src/shared/media-contract.ts`, fixtures)
was **not edited**.

## What changed

| Item | Files | Summary |
| --- | --- | --- |
| 2. One feed projection | `src/services/media/feed.ts` (new) | `observationMediaFromMetadata` validates `metadata.cmem_media_v1` with the shared `validateMediaManifest` and returns the manifest, or `undefined` for no refs, `attachments:[]`, malformed JSON or an invalid namespace (fails closed to an image-free row). `withObservationMedia(row, keepMetadataColumn)` adds `media` and omits the key entirely for image-free rows. |
| Paged / initial feed | `PaginationHelper.getObservations` | Selects `o.metadata` only to project `media`, then drops the raw column, so image-free rows keep the exact pre-media key set. The viewer's initial load is the first page (SSE `initial_load` carries projects only). |
| By-id / batch | `DataRoutes` `GET /api/observation/:id`, `POST /api/observations/batch` | Same projection. These routes already returned `SELECT *` (including the `metadata` column); that column is kept for existing MCP/API consumers and `media` is added. |
| SSE | `ResponseProcessor.syncAndBroadcastObservations`, `agents/types.ts` | After commit, a turn that delivered pixels (the only kind that can write a manifest) reads the committed row's metadata and adds the same `media` to `new_observation`. Other turns skip the read. |
| Readiness / provenance routes | `MediaRoutes`, `MediaStore` | `GET /api/media/:id` adds only `capturedAt` (row `created_at`), projected explicitly, and never reads provenance (see review fixes). New **owner-only** `GET /api/media/:id/details` (same loopback/own-page guard, no-store, no ETag) returns `{id, platform, sourceShape, sourceLocatorPath, sourceAvailability}`; replicas return nulls. Registered before `/:id/:variant`. |
| 1. Viewer | `src/ui/viewer/types.ts`, `utils/media.ts`, `hooks/useMediaStates.ts`, `components/ObservationMedia.tsx` (new), `ObservationCard.tsx`, `viewer-template.html` | Copied L12 types (`ObservationMedia`, `ObservationMediaRef`, `MediaMetadataResponse`, `MediaOwnerDetailsResponse`). The card renders `ObservationMediaSection` only when `media.attachments.length > 0`. Strip: at most 4 thumbnails (LLM derivative, `loading="lazy"`), "+N" on the last tile, total count, "(more on the source event)" for `overflow`, a "not inspected" badge, status tiles, and Retry on read errors. Gallery: a portal modal (`role="dialog"`, `aria-modal`, labelled title) with the viewer variant. Esc closes; ←/→ move without wrapping; Home/End jump. Tab/Shift+Tab are trapped. Focus goes to Close on open and back to the opening thumbnail on close, and is pulled back into the dialog whenever a control disappears or disables. Body scroll is locked, and a click on the backdrop closes. Provenance shown: inspection, status, recipe, dimensions, WebP size and capture time. "Show source details" fetches the owner-only route on explicit request and shows source availability, platform, shape and locator (replicas: "Synced from another device"). Alt text is built from the bounded label only: `Image <label> (i of n) attached to observation #id`. Mobile (≤600px) uses a full-screen dialog and smaller tiles. Only existing theme tokens are used. |
| State mapping | `utils/media.ts` `mediaDisplayStateFrom` | 200 `ready` → image; `converting` / 409 → **pending** ("Processing…"); `unresolved_replica` → **downloading** (never failed); `failed` + an image-bound code (`pixel_limit`, `unsupported_format`, …) → **rejected**; other `failed` → **failed** (code sanitized to `[a-z_]`); 404 → **unavailable** ("Image removed"); 403/503/network/`<img>` error → retryable **error**. Pending/downloading re-poll every 4 s, up to 30 times. "Unavailable source but canonical retained" shows in the owner details as "Source file no longer available; converted copy retained". When the 30 polls run out, the tile shows "Still processing" / "Still downloading" with a Retry that restarts polling. Uninspected shows as a badge and in the gallery. |
| 3. Gateway correlation | `src/services/worker/cmem-request-correlation.ts` (new), `OpenRouterProvider` | **Choice: request header `X-Cmem-Correlation`**. Its value is compact JSON `{"request_id":"<uuidv4>","attempt":<1..1000>,"event_keys":[<≤4 lowercase sha256 hex, deduped, in order>]}`, asserted at most 1 KiB (about 360 bytes at the maximum). It is sent **only** when `isCmemGatewayUrl(apiUrl)`, on every chat-completions attempt (observations, summaries and others). `request_id` is fresh per logical request (`sendChatCompletion`), and `withRetry` attempts share it while `attempt` increments. The text-only resend after `media_request_invalid` is a **new** request_id that carries the same originating event keys. Event keys are the local media event keys (`sha256([1,platform,identity])`) of the images in the turn, or `[]`. Non-hex values are dropped, never sent. The chat body is unchanged. The local side has no server validator. **The Pro agent must accept and validate this header, or the orchestrator must reconcile.** |
| 4. Metrics / logs | `MediaStore.capture` | New `info` metric `Media converted` with exactly `{attachmentId, recipe, sourceShape, sourceBytes, viewerBytes, llmBytes, width, height, conversionMs}`. The conversion-failure warn now adds `{attachmentId, recipe, sourceBytes, conversionMs}` to `code`. I audited existing media logs (capture, store, cloud, replica, linkage, inference, capability): each logs only codes, counts, IDs or status. |
| 4. Privacy disclosure | `docs/public/configuration.mdx` (new "Screenshots and Images (opt-in)" section, plus `media-v1/` in the data-dir tree), `docs/public/cloud-sync.mdx` ("What syncs" bullet and privacy warning), `README.md` (feature bullet) | Covers: off-by-default independent flags; what is retained (converted WebP viewer and model copies, EXIF stripped, originals not kept, base64 never in `tool_uses`, prompts, logs or sync); location `<data dir>/media-v1/<id>/` (0700/0600, loopback same-page only); retention tied to references with roughly 30 s background cleanup; private cloud upload only when capture **and** Cloud Sync are on, with cloud deletion following local deletion; third-party inference (the model-sized copy goes to OpenRouter or the cmem.ai gateway and its routed provider for that one request only, a text-only resend on rejection, other providers text-only); the log/metric field policy; the correlation header. |

## Tests

| Command | Result |
| --- | --- |
| `bun test tests/viewer/observation-media.test.tsx` (new, 11) | PASS. Image-free card markup is byte-identical to the markup captured from `ObservationCard` at `22a2a1853` (and `attachments:[]` renders the same). Strip bounds/+N/overflow count/alt text/badges. Loading/rejected/failed/removed/error with Retry. Readiness mapping for every route outcome (replica is downloading, never failed; path-like failure codes sanitized). Esc/arrows/Home/End. Tab wrap. Dialog role/aria/viewer src/provenance. Locator only after an explicit details response. No `/Users/`, `file://`, `data:image`, `http(s)://`, `source_pointer` in generic rendering. |
| `tests/media/inference-observation-turn.test.ts` (+6) | **Paged, by-id, batch and SSE `media` are identical** to the stored manifest after a real two-image turn. The serialized feeds contain no scratch path, `source_pointer`/`source_sha256`, event key, `data:image`, `.webp`, `event_identity` or tool-use ID. Image-free rows have no `media` key and the exact previous paged key set. An invalid namespace fails closed on paged and by-id. Correlation tests: gateway header present, ≤1 KiB, exact keys, `attempt:1`, event key matches, absent on direct openrouter.ai; a 503 retry keeps request_id with attempt 1→2; a text-only resend gets a new request_id with the same event keys. |
| `tests/worker/http/routes/media-routes.test.ts` (+2, fixture updated to a valid provenance) | `capturedAt`/`sourceAvailability` present without the path; `file_present`→`file_missing` after deleting the source. Owner details return the locator only from the guarded route (403 for foreign Origin, forwarded headers or cross-site). A replica returns nulls and `unresolved_replica`. 404 for a missing ID. |
| `tests/media/capture.test.ts` (+1) | The capture metric has exactly the allowed keys, all string or number, with no path, base64, label or caption. |
| `tests/worker/cmem-request-correlation.test.ts` (new, 3) | Cap at 4 distinct keys, non-hex dropped, invalid IDs and attempts throw. |
| `bun test tests/media tests/worker/http tests/viewer tests/worker/cmem-request-correlation.test.ts tests/worker/agents tests/worker/openrouter-*.test.ts tests/worker/observer-image-strip-live-path.test.ts tests/sqlite tests/transcripts tests/services/worker/session-message-buffer.test.ts tests/cowork` | **1139 pass, 0 fail** |
| Wide sweep `tests/worker tests/services tests/cli tests/server tests/sdk tests/shared` | 3679 pass, 2 fail. `field-deadline-wire` also fails on a clean `22a2a1853` checkout (verified in a temporary `.scratch` worktree, since removed). The other failure is the known cross-file mock-pollution error recorded in Phases 2 and 4. |
| `npm run typecheck` | exit 0 (root + viewer) |
| `npm run build` | exit 0 (`.scratch/p6-build.log`). Kept: `plugin/ui/viewer.html`, `plugin/ui/viewer-bundle.js`, `plugin/scripts/worker-service.cjs(.map)`, `plugin/scripts/transcript-watcher.cjs(.map)` (it bundles `MediaStore`, so it carries the metric change). Restored with `git checkout`: context-generator, mcp-server, onboarding-explainer.md, observations/files.js(.map), tv.html. Note: `viewer.html` also carries pre-existing template drift that earlier phases kept restoring (about 677+/149− total; this phase's CSS is about 270 lines). This is the regenerated output of the current template. |

## Browser verification

A scratch worker ran on port **38456** with `CLAUDE_MEM_DATA_DIR=.scratch/p6-viewer/data` (Chroma off, `DO_NOT_TRACK=1`). The data was seeded by `.scratch/p6-viewer/seed.ts`: 6 real converted generated-pixel screenshots plus pending, rejected and replica rows, and one image-free row. I drove it with Chrome DevTools and then stopped it. Screenshots are in `.scratch/p6-viewer/shots/`: `desktop-feed.png`, `desktop-lightbox.png`, `mobile-feed.png`, `mobile-lightbox.png` (390×844 @2x emulated).

Verified live:
- the 4 thumbnails decode, with the label-based alt text;
- "+2" and "6 images (more on the source event)";
- the open dialog focuses Close, and → moves to "Image 2 of 6";
- End disables Next, and Shift+Tab wraps from Close to the last control;
- "Show source details" loads the owner details and focus stays in the dialog;
- Esc closes, focus returns to the opening thumbnail, and body overflow is restored;
- no horizontal scroll at 390 px, and the mobile dialog is full screen.

Two defects found live were fixed:
1. Esc stopped working after the details button unmounted, because focus fell to `<body>`. Keys are now a document capture listener, plus a post-render focus guard.
2. The "not inspected" badge wrapped over the status on mobile. It is now nowrap with an ellipsis.

The only console errors are the expected 409s from the pending/replica polls.

## Unmet, open or coordination

- **Correlation reconciliation (Pro).** The header choice above is the L side only. Pro must parse and validate `X-Cmem-Correlation` and fold it into its ledger (Phase 6 item 4). Pro "derives it server-side" for hook calls. L persists no processing/result ledger locally: items 3, 5 and 6 (metering, economics, admin display) are P-side.
- **Replica display in the live run.** With no cloud configured, the metadata route's replica resolver answers 409 `media_not_ready`, so the viewer shows "Processing…". "Downloading…" appears only when the route returns `unresolved_replica`. Both are pending-type states; neither is ever shown as failed.
- **Merged rows over SSE.** A Tier-0 dedup merge that adds refs to an existing row is not re-broadcast (pre-existing behaviour: merged rows are skipped from SSE). The new refs appear on the next paged/by-id read.
- **No DOM test library** exists for the viewer (bun + pure utils). Component tests use `react-dom/server` static rendering plus pure keyboard/focus/state functions. Live focus behaviour was verified in Chrome only, not in CI.
- `GET /api/observations/by-file`, search results and MCP outputs do not get `media` (not viewer feeds). They are unchanged.
- **Contract defects:** none new. The open items from Phase 5 (null namespace wording, frozen capture matrix, the `encoder:'source'` upload form, lane event identity) still need the coordinated doc update. Feed field naming (`media` = the validated manifest) is an L decision not in the contract; the Pro cloud normalization should use the same shape or the orchestrator should pick one.

## Review fixes (after "Phase 6 local VERIFIED")

| # | Finding | Fix | Evidence |
| --- | --- | --- | --- |
| 1 | `GET /api/media/:id` ran `ownerSourceDetails()` (parse + validate + `existsSync`) on every read, including polls, and invalid provenance failed the read | Generic metadata no longer touches provenance. `sourceAvailability` exists only on `/api/media/:id/details`. The original route-test fixture (deliberately invalid provenance) is restored. | `media-routes.test.ts` "generic metadata never reads provenance": the invalid-provenance row gives metadata 200 `ready`, and `/details` gives 503 with no path. The key list is `capturedAt` plus the original 7. "only the owner details route reports source availability" covers present→missing via `/details`. |
| 2 | Unused `MediaStore.sourceAvailability` | Removed | typecheck exit 0 |
| 3 | Replica owner details said "none (inline image)" | Shows "Synced from another device; converted copy retained", with no platform/shape/file rows | `observation-media.test.tsx` "labels a replica as synced from another device" |
| 4 | No way to resume after 30 polls | `useMediaStates` marks the state `stalled`. The strip and gallery show "Still processing" / "Still downloading" and Retry (`canRetryMediaState`), and Retry resets the poll count and timer. | "offers Retry once bounded polling … stops". The hook's timer path itself is not DOM-tested: there is no DOM library. |
| 5 | Silent fail-closed in `feed.ts` | `warn` with `{code}` only (`invalid_manifest`, `manifest_too_large`, …) for an unparseable or invalid stored manifest | `inference-observation-turn.test.ts` invalid-namespace test: every log payload is exactly `{code:'invalid_manifest'}` and never contains the bad ID |

Rerun after the fixes:
- `bun test tests/media tests/worker/http tests/viewer`: **605 pass, 0 fail**.
- Other Phase 6 suites (correlation, `tests/worker/agents`, `openrouter-*`, image-strip live path, `tests/sqlite`, `tests/transcripts`, session buffer, `tests/cowork`): **537 pass, 0 fail**.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0. Afterwards only `viewer.html`, `viewer-bundle.js`, `worker-service.cjs(.map)` and `transcript-watcher.cjs(.map)` differ under `plugin/`; the other regenerated files were restored.
