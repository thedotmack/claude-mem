# Phase 2 handoff: durable local capture, storage and controlled reads

Repository L, branch `feat/image-aware-observations`, on top of Phase 1 commit
`8a74b75e2`. Nothing is committed or pushed in this phase. Media capture stays
behind `CLAUDE_MEM_MEDIA_CAPTURE_ENABLED` (default `'false'`).
`CLAUDE_MEM_MEDIA_INFERENCE_ENABLED` is not read anywhere in Phase 2. No model
call, paid request, bucket or production database was touched.

## Migration

- **SQLite v61** (`src/services/sqlite/media.ts` `ensureMediaSchema`, called
  last in the `SessionStore` constructor after v60). It uses the same
  transaction plus `INSERT OR IGNORE INTO schema_versions` bookkeeping as v60.
  All DDL is `IF NOT EXISTS` and runs on every startup, with no early return
  once the version is recorded. Older migrations rebuild `observations` and
  `sdk_sessions`, and SQLite drops the triggers on those tables when that
  happens. Running v61 every startup puts the triggers back.
- Tables:
  - `media_events(event_key PK, session_db_id, platform, event_identity, state retained|deleted, result_state, created_at)`: the durable source-event manifest, written before the RAM enqueue.
  - `media_attachments(id UUIDv4 PK, replay_key UNIQUE, provenance, recipe, state converting|ready|failed|deleted, failure_code, encoder_version, variants, lease_until, upload_state pending|uploaded|failed|cancelled, created_at)`: holds provenance, variant descriptors (sha256/width/height/bytes) and state. No source bytes are stored.
  - `media_event_refs(event_key, attachment_id, label)`: event-retention references, kept separate from observations.
  - `observation_media_links(observation_id, attachment_id, event_key, label, inspection)`: keyed by SQLite observation ID. Phase 4 populates it. `MediaStore.linkObservation` exists and is tested.
  - `media_cleanup_jobs(attachment_id PK, directory, queued_at, attempts, retry_at, last_error)`: the durable file-cleanup outbox.
- Triggers:
  - `media_observation_delete` (AFTER DELETE ON observations)
  - `media_session_delete` (BEFORE DELETE ON sdk_sessions)

  Each trigger queues cleanup for attachments that are no longer referenced, then tombstones them.

## Endpoints

- `GET /api/media/:id` returns safe metadata only: `{id,state,recipe,encoderVersion,viewer,llm,failureCode}`, with the fields projected explicitly.
- `GET /api/media/:id/:variant` returns `image/webp`, with `variant ∈ {viewer, llm}`.
- Both endpoints follow these rules:
  - The id must be a lowercase UUIDv4. The file path comes from the database row plus a containment check, never from the request path.
  - Responses carry `Cache-Control: private, no-store`, `nosniff` and `CORP: same-origin`, with no ETag.
  - The socket peer must be loopback. `req.ip`/trust-proxy is ignored, and any `Forwarded`/`X-Forwarded-*`/`X-Real-IP` header is denied. This means LAN is denied even when the operator enables LAN text reads.
  - The Host must be loopback (DNS-rebinding guard). Origin/Referer must be this worker's own page, and Sec-Fetch-Site cross-site/same-site without Origin/Referer is denied.
  - Errors are the bounded `MEDIA_ERROR_CODES`: 400/404/409/503. There is no static mount of `DATA_DIR`.
- Storage location: `DATA_DIR/media-v1/<uuid>/{viewer,llm}.webp`, staged under `media-v1/.tmp/` and published by one atomic directory `rename`.

## Changed files

New:
- `src/shared/media-ingress.ts`: native-shape scanner (shapes copied from L1 fixtures) plus `boundObservationDispatch`, the pre-dispatch 4 MiB aggregate inline bound. The global 5mb JSON cap is unchanged.
- `src/services/media/capture.ts`: ingest-boundary capture. It handles platform event identity, trusted Read locators and descriptor substitution.
- `src/services/media/store.ts`: `MediaStore`: capture/convert/publish, replay reuse, linking, event deletion and reconciliation.
- `src/services/media/files.ts`: contained, no-symlink, bounded file-descriptor reads (fd reads).
- `src/services/sqlite/media.ts`: the v61 schema and triggers.
- `src/services/worker/http/routes/MediaRoutes.ts`: the UUID routes.
- Tests: `tests/media/ingress.test.ts`, `tests/media/capture.test.ts`, `tests/worker/http/routes/media-routes.test.ts`.

Modified:
- `src/services/worker/http/shared.ts`: capture runs after the exclusion/skip/subagent/privacy gates and before serialization. Descriptors go to both `tool_uses` and the RAM text.
- `src/cli/handlers/observation.ts`: dispatch bound on both worker and server-runtime sends; hook log redaction.
- `src/services/worker/http/middleware.ts`: the request-log summary strips image bodies.
- `src/services/worker-types.ts`: `mediaRefs`/`mediaEventKey`/`mediaFailures` side fields on `ObservationData`/`PendingMessage`. `content` and the tool fields stay strings.
- `src/services/worker/SessionManager.ts`: passes the side fields to the buffer.
- `src/services/worker/DatabaseManager.ts`: `MediaStore` and a 30 s unref'd reconciliation timer.
- `src/services/worker-service.ts`: registers `MediaRoutes`.
- `src/services/sqlite/SessionStore.ts`: calls v61.
- `scripts/build-hooks.js`: `sharp` is now external in `transcript-watcher.cjs` too, because `processor.ts` reaches the lazy converter.
- Regenerated build output: `plugin/scripts/{worker-service,server-service,transcript-watcher}.cjs(.map)` and `plugin/sqlite/SessionStore.js(.map)`. Unrelated regenerated artifacts reflected main-source drift, not this change, so I restored them with `git checkout`: viewer html/bundle, onboarding md, context-generator, mcp-server and observations/files.

## Checklist

| Item | Evidence | Result |
| --- | --- | --- |
| Every supported native shape reaches conversion before stripping; rejected/disabled images leave bounded text and honest state | `capture.test.ts`: the anthropic/Read base64/MCP JSON-string/OpenAI data URL shapes each produce a `ready` attachment with decodable WebP variants, and the queued text holds `retained` plus the id. The trusted Read locator test passes. Disabled, corrupt, no-identity, unsupported format, >4 images and loose data URL each produce a `disabled`/`rejected`/`failed` descriptor. `ingress.test.ts` covers the shapes. | PASS |
| Multi-image base64 above inline bounds sanitized before HTTP; text reaches ingestion; global JSON limit not raised | `ingress.test.ts`: five 1.5 MB images plus captions go in. Under 5 MiB comes out, with two bodies kept (4 MiB aggregate), three `source_too_large` descriptors and both captions. A 6 MB text wall is clipped head/tail. `express.json({limit:'5mb'})` is unchanged. | PASS |
| Raw `tool_uses`, compressed fields, RAM text and logs have no base64/data-image from new capture | `capture.test.ts` checks `tool_uses` row, queued strings and media rows. `ingress.test.ts` checks the request-log summary. The L1 live-path compressor/prompt test passes with the new disabled-path descriptors. | PASS |
| Restart/replay and repeated identical events reuse durable IDs/assets; RAM IDs never in replay keys | Same event three times, the third through a new `MediaStore` over the same DB/DATA_DIR, gives one attachment, one event, one directory. The key is SHA-256 over `[1,platform,identity]`, where identity hashes `(platform, contentSessionId, toolUseId)`. A real `SessionManager` buffer carries the refs, and its RAM id is absent from media rows. Changed bytes on replay give `checksum_mismatch`. | PASS |
| Source removal leaves canonical readable and derivative rebuildable | Trusted Read file captured, then deleted. The viewer variant still verifies its sha256. `convertMedia(canonical,'image/webp')` rebuilds a bounded 320x180 derivative. | PASS |
| Traversal/symlink/foreign-origin/LAN fail; UUID route cannot return unrelated files | `media-routes.test.ts`: foreign/other-port/null origins, forwarded headers, rebinding Host, LAN peers, malformed IDs/variants, `?path=` ignored, symlink leaf and directory. `capture.test.ts`: symlink, `../`, outside-project, mismatched `file_path`, non-Read tool and directory locators. | PASS |
| Item/session deletion, shared-asset references, process interruption and cleanup retry | Routes: existing `DELETE /api/observation/:id` and session delete through the real triggers. Capture: two observation links plus an event ref, removed one at a time until physical removal. Interrupted conversion: the lease expires, reconciliation removes `.tmp`, and replay re-converts with the same id. Crash between publish and ready commit leaves no orphan. A cleanup failure (symlinked dir) keeps the job with backoff, then removes the files later. A late replay of a deleted event is refused. | PASS |
| Regression command | `bun test tests/worker/observer-image-strip-live-path.test.ts tests/sqlite tests/transcripts tests/services/worker/session-message-buffer.test.ts`: **369 pass, 0 fail** (47 files) | PASS |
| New media tests | `bun test tests/media tests/worker/http/routes/media-routes.test.ts`: **59 pass, 0 fail** (ingress 14, capture 20, routes 13, plus Phase 1's contract 1, converter 10, evaluation 1) | PASS |
| `npm run typecheck` | exit 0 | PASS |
| `npm run build` | exit 0. `sharp` is not bundled in any `plugin/scripts/*.cjs` (only `import("sharp")` remains). | PASS |

I also ran a wider sweep, `bun test tests/worker tests/services tests/cli tests/server`: 2738 pass, 2 fail. Both failures also occur on the Phase 1 baseline `8a74b75e2`, checked in a temporary worktree in `.scratch/` that I then removed: `field-deadline-wire` (timing), and an unhandled "Export named 'WorkerService'" error caused by cross-file mock pollution in `worker-pending-session-resume`. The baseline gave 2725 pass with the same 2 failures.

Anti-pattern scan: I ran the Phase 1 rg pattern over the Phase 2 files. Matches are confined to the base64 decode/scan boundary. There is no `input_references`, `getPublicUrl`, `pro_observations`, `fetch(`, static mount or inference flag read. Nothing depends on durable `pending_messages`. Historical raw `tool_uses` rows are not touched.

## Decisions

- Disabled capture still replaces recognized image bodies with `converter_disabled` descriptors before `tool_uses` and RAM. Image-free payloads keep their identity and encoding. This narrows what new raw tool rows retain. Historical rows are not migrated.
- Event identity is the platform tool-use ID, namespaced by SHA-256 of `(platform, contentSessionId, toolUseId)`. An event without one, or from a platform outside `claude|codex|cowork`, stays text-only with `unsupported_source`. Phase 2 adds no transcript-record identity. The fallback stays reserved until a fixture-proven transcript record exists, which is Phase 5.
- Trusted file locators are accepted only for `Read` with a typed `{type:'image',file:{path}}`. The path must equal `tool_input.file_path` and resolve inside the event's `cwd` as a regular non-symlink file of 3 MiB or less. Files outside the project are rejected. This is conservative, and Phase 5 can widen it.
- Recipe is fixed to `screenshot-v1` at capture. There is no content classification, per the contract.
- The converter uses the frozen single no-wait slot. A concurrent capture fails with `conversion_busy`, and the row is retryable on replay.
- A replay of the same event and pointer with different bytes is rejected with `checksum_mismatch`, never re-pointed. A deleted event or attachment is never resurrected.
- Fixed a bug in the prior session's v61 SQL: cleanup previously tombstoned every attachment that had a cleanup job. That included still-referenced failed conversions whose temporary files were being cleaned. Now only unreferenced attachments are tombstoned.
- Physical file removal is asynchronous through the durable outbox. It runs on reconciliation at startup, on each capture, and every 30 s. Metadata becomes unreadable immediately inside the existing deletion transaction.
- Tests write scratch data under the project-local `.scratch/` (gitignored), not the system temp directory. The route test's 1x1 PNG was replaced with a Sharp-generated fixture, because the strict decoder rejected the tiny PNG.
- `docs/media-contract-v1.md` is unchanged. It must stay byte-identical with Pro, so the capture-matrix update is recorded here instead.

## Unresolved gaps

- Inference, observation links written by the response processor, and `inspected` state are out of scope; they belong to Phase 4. `media_events.result_state` and `observation_media_links` exist but nothing in production writes them yet.
- The worker sends no after-commit SSE/notification for media deletion; file cleanup is timer/outbox-driven. Phase 6 viewer work may want a broadcast.
- Capture runs inline on the ingest request, up to about 5 s per image. A burst of image events can hit `conversion_busy` because of the one-slot policy, and those images are retryable only on replay.
- Codex/Cowork prompt attachments, transcript-record identity, `services/sync-api`/cloud upload (`upload_state` stays `pending`), and Windows native capture execution are not covered here.
- The capture-matrix rows in the shared contract doc still say "capture implementation disabled". They need a coordinated L/P doc update when a lane is enabled.

## Review fixes

An independent review blocked Phase 2. Each fix below has a regression test
that failed against the reviewed code and passes now. Before-evidence: 9
failures in `ingress.test.ts`, 13 in `capture.test.ts` (including the index
plan test), and 2 each in `observer-image-strip-live-path.test.ts` and
`media-routes.test.ts`. The real Read shape was checked against local Claude
Code transcripts. Only the structure was copied; every test image is
generated.

| # | Defect | Fix | Regression test |
| --- | --- | --- | --- |
| 1 (blocking) | Past 4096 nodes or depth 20, the walker replaced every later value with `{media_status:{code:'invalid_manifest'}}`. That corrupted image-free payloads on every PostToolUse, even with flags off. | Past either bound the walker returns values unchanged, matching the `sdk/prompts.ts` passthrough. The only record is a `walkLimitReached` flag on the scan result. No media failure is added and no text is rewritten. The oversize `clipOversizedValue` also passes through past its depth bound. | `ingress.test.ts` "walk bounds never rewrite image-free payloads": a Glob with 5000 filenames, a 25-level object, and 25-level JSON text that mentions `image_url`. Each is byte-identical through `boundObservationDispatch` and all scan stages. Also covers the flag, and an image inside the bound being captured ahead of a huge list. |
| 2 (blocking) | Real Read results name the MIME `file.type`, so every real Read image was rejected `unsupported_format`. | `declaredReadImageMimeType` accepts `file.media_type`, then `file.type`. Declared MIMEs are hints: a declared unsupported format is still rejected early, a missing one goes to the worker, and the worker always converts the magic-byte-sniffed format (`sniffSupportedImageMimeType`). The invented fixtures in `capture.test.ts` and `observer-image-strip-live-path.test.ts` are replaced with the real shape. | `ingress.test.ts` "real Claude Code Read image results" (6 tests). `capture.test.ts` covers the real-shape `claude_read_base64` capture, no declared type, and a declared type that disagrees with the bytes. Live path: the Read test and a prompt-stripper-only test on the real shape (keeps `image/png`). |
| 3 | `safeStatusFields` re-stringified any JSON-looking string containing `media_status`. | `substituteFinalStatuses` returns immediately when no statuses exist. It keeps identity when nothing changed, and a string is re-serialized only when a status was substituted inside it. | `capture.test.ts` "status substitution leaves untouched text alone": a hand-formatted string stays exact and an object keeps its identity. |
| 4 | Deletion triggers scanned every attachment. | New `idx_media_event_refs_attachment` index. The observation, session and event delete paths now consider only the attachments that row referenced. They ignore the refs or links being removed in the same batch, queue cleanup before removing those refs, and use indexed `NOT EXISTS`. Triggers are dropped and recreated each startup so no stale definition lingers. `queueUnreferencedMedia` is replaced by `queueCleanupForDeletedEvent`. | `capture.test.ts` "scoped deletion triggers": the query plan shows `SEARCH ... USING COVERING INDEX idx_media_event_refs_attachment` (it was a full `SCAN` before). An unrelated unreferenced attachment survives observation, session and event deletes, and an asset still referenced by another session's event survives a session delete. |
| 5 | Shape-recognizer drift between ingress and the prompt stripper. | New `src/shared/native-image-shapes.ts` holds the shared predicates (`anthropicImageSourceOf`, `claudeReadImageFileOf`, `isMcpInlineImageBlock`, `openAiImageUrlOf`, `declaredReadImageMimeType`), used by both `media-ingress.ts` and `sdk/prompts.ts`. The prompt stripper now carries the Read `file.type` as `media_type`. | Live-path and `tests/sdk/prompts.test.ts` (plus the other prompt suites, 196 pass). |
| 6 | Dense formatting. | `media-ingress.ts` and `capture.ts` rewritten with readable formatting and verbose names (`recognizeImageBlock`, `rejectionCodeFor`, `handleImageBlock`, `walkRecordEntries`, `substituteFinalStatuses`, `assertReplayMatchesPriorSource`, ...). | Covered by all of the above. |
| 7 | Read elision replaced the whole `file` object. | Only the byte field (`data`/`base64`/`url`) is removed. Siblings such as `type`, `originalSize` and `dimensions` stay, and the elision descriptor is added next to them. A typed file locator keeps its `path`. | `ingress.test.ts` "elision replaces only the byte field". `capture.test.ts` "captured Read descriptor keeps originalSize and dimensions". The live-path prompt contains `originalWidth`. |
| 8 | Unbounded logging, unbounded cleanup retries, and reconcile on the hot path. | Capture failures log `{code, shape}` only (`INGEST`). Store conversion failures and cleanup failures log `{code}` / `{code, attempts}` (`DB`). Cleanup retries use exponential backoff from 30 s, capped at 1 h. After `MEDIA_CLEANUP_MAX_ATTEMPTS = 8` the job is parked with `last_error='retry_limit'` and is never retried, keeping a durable record of files that need manual removal. `reconcile()` no longer runs inside `MediaStore.capture`; only the existing startup run plus the 30 s unref'd timer in `DatabaseManager` call it. | `capture.test.ts` "cleanup retries and hot-path reconciliation": a due cleanup job is untouched by ingest; a repeatedly failing job stops at 8 attempts with `retry_limit` and its logs contain no paths; a converter error mentioning a path logs only `storage_unavailable`. |
| 9 | The metadata route returned an Express ETag. | Metadata, 403 and error JSON are written with `res.end` (`sendJsonWithoutCacheValidators`), so there is no ETag and no 304 on `If-None-Match`. | `media-routes.test.ts`: no ETag on metadata/404/403, and `If-None-Match: *` still returns 200. The existing variant test now also asserts no ETag on metadata. |

Verification after the fixes:

- `bun test tests/worker/observer-image-strip-live-path.test.ts tests/sqlite tests/transcripts tests/services/worker/session-message-buffer.test.ts`: **370 pass, 0 fail** (47 files).
- `bun test tests/media tests/worker/http/routes/media-routes.test.ts`: **84 pass, 0 fail** (6 files).
- Prompt-related suites (`tests/sdk/prompts.test.ts`, history-pruning, observer-recycle, context-overflow, context-window, codex batch, system-anchor, response-processor): **196 pass, 0 fail**.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0, log in `.scratch/build-review-fixes.log`. Unrelated regenerated artifacts were restored with `git checkout`: context-generator, mcp-server, onboarding-explainer.md, observations/files.js, tv.html, viewer.html and viewer-bundle.js. The only changed generated files are `plugin/scripts/{worker-service,server-service,transcript-watcher}.cjs(.map)` and `plugin/sqlite/SessionStore.js(.map)`.

Behavior changes to note:

- A typed Read file locator keeps `file.path` in the text after capture. Before, the whole `file` object was replaced.
- An inline image with no declared MIME is now a candidate, and the worker sniffs its format. Before, it was rejected as `unsupported_format`.
- An image located past the walk bounds (after 4096 nodes or deeper than 20 levels) is no longer captured at ingest. It is left unchanged, and the prompt-time stripper in `sdk/prompts.ts` still removes its bytes before any model call. However, `tool_uses` and the RAM text can still hold those bytes for such pathological payloads. This is the trade-off the review chose over corrupting image-free payloads.
