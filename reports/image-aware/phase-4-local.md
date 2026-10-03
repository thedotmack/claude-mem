# Phase 4 handoff (L): capability-gated multimodal inference and validated linkage

Repository L, branch `feat/image-aware-observations`, on top of Phase 2 commit
`4967cb463`. Nothing is committed. Image inference is off by default behind
`CLAUDE_MEM_MEDIA_INFERENCE_ENABLED`, which is separate from the capture flag.
No paid model call was made, and no image-quality qualification is claimed.
Every HTTP test uses a mocked `fetch`.

The frozen contract files (`docs/media-contract-v1.md`,
`tests/fixtures/media-v1/inference/`, `scripts/media/contract-checks.ts`) were
not edited. The fixtures and the doc are byte-identical with Pro.
`contract-checks.ts` differs from Pro only in the contract import path, which
predates this phase.

## What changed

New files:
- `src/services/worker/media-capability.ts`: image qualification.
  - `resolveCatalogModel` is copied from Pro P1. `qualifyCatalogModels` requires the primary model and every fallback to qualify.
  - `localImageTurnParameters` requires `max_tokens` and `temperature`, plus `reasoning` only when the typed effort is sent to openrouter.ai.
  - The cmem gateway capability client uses `GET <base>/capabilities` with the memory key as the bearer. It parses the response strictly (exact keys, `version:1`), caches for `ttl_seconds` (60 s on any failure), keeps one request in flight per base URL and key, and has a reset seam.
  - `resolveObserverImageCapability` applies the flag first. Then the gateway uses only its own capability response, direct openrouter.ai uses the catalogue, and any other base URL gets `endpoint_unsupported` (a local-only reason).
- `src/services/media/inference.ts`:
  - `prepareTurnImages` reads the Phase 2 LLM derivative through `MediaStore.readVariant(id,'llm')`. It takes images in event order, then ordinal order, up to the capability bounds. It checks WebP magic bytes and the per-image and aggregate byte and data-URL limits. An unreadable image is skipped and stays uninspected.
  - `freezeResponseMedia` freezes labels and sources only, never pixels.
  - `imageTurnContent` and `turnImageInstruction` produce the contract parts verbatim.
  - `linkAttachmentRefs` implements the frozen linkage rules.
- `src/services/media/linkage.ts`:
  - `mergeMediaManifest` follows the manifest-merge rules: union by ID, inspection is an upgrade-only OR, 32 refs maximum with sticky `overflow`, an invalid namespace fails closed, and other metadata keys are preserved.
  - `writeObservationMediaLinks` writes manifests and junctions. It bumps `sync_rev` and clears `synced_at` for native rows, and leaves replica rows untouched.
  - `writeMediaEventResults` and `committedMediaEventResult` handle the durable event results.
- Tests:
  - `tests/media/inference-capability.test.ts` (31)
  - `tests/media/inference-linkage.test.ts` (30)
  - `tests/media/inference-observation-turn.test.ts` (27, including the verification fixes)
  - Additions to `tests/worker/openrouter-messages.test.ts` (4) and `tests/worker/context-window.test.ts` (1)

Modified files:
- `context-window.ts` (L15): the one catalogue cache now keeps `id`, `canonical_slug`, `alias_target`, `context_length`, `architecture` modalities and `supported_parameters`. Values are bounded and pricing is dropped. The TTL, negative cache, in-flight dedupe and reset seam are unchanged. `fetchOpenRouterModelCatalog` serves both context-window lookups and image qualification.
- `OpenAICompatibleProvider.ts`:
  - New `prepareObservationMedia` hook (no-op by default) and an optional `turnImages` argument to `query`. Only the observation path passes `turnImages`. Summary, wrap-up and field condensation never pass it.
  - The frozen media map goes into `snapshotResponseContext`.
  - The data URLs are cleared once the request settles.
  - If the request went out text-only, the context is re-frozen with `imagesDelivered:false`.
- `OpenRouterProvider.ts` (L5):
  - `withTurnImages` changes only the final user message into the text-first parts array, after history assembly, anchoring and coalescing. The body type is widened to `OpenRouterRequestMessage`.
  - A text-only request uses the identical message array, so it is byte-identical to today's request.
  - A gateway `400` containing `media_request_invalid:` becomes a non-retryable classified error. The turn is resent once, text-only, and the result is `imagesDelivered:false`.
- `agents/ResponseProcessor.ts` (L7/L8/L19):
  - `ResponseContext.media` is the frozen per-turn label → (event_key, attachment_id, event_label) map.
  - Linkage runs only when `imagesDelivered`.
  - `storeObservations`, then manifests, junctions and `media_event_results`, all commit in one SQLite transaction before `confirmClaimedMessages`. The link writes run in a nested savepoint: a bookkeeping failure is logged and never rolls back the stored observations, so it never causes another vision call.
  - Skip, dropped-batch and missing-memory-session skip paths record `result_state='skipped'` before confirming.
  - Cloud sync is notified when a native row's manifest changed.
  - Logs carry reason codes and counts only, never label text.
- `sdk/parser.ts`: adds an optional `attachments` list to `ParsedObservation`. It comes from the first lowercase `<attachments>` block, matched case-sensitively, at most 16 elements of at most 128 characters each. `attachments` and `attachment` are added to the schema tag set, and `attachments` to the salvage strip regex.
- `sqlite/media.ts`: adds the `media_event_results(event_key, observation_id)` table and records schema version **62** in the same `ensureMediaSchema` run. The observation-delete and session-delete triggers and `MediaStore.deleteEvent` also remove these rows.
- `http/shared.ts`: on replay, an event whose `result_state` is already `stored` or `skipped` returns `{status:'skipped', reason:'already_processed'}` and is not re-queued, so there is no model call.
- Regenerated build output: `plugin/scripts/{worker-service,server-service,transcript-watcher}.cjs(.map)` and `plugin/sqlite/SessionStore.js(.map)`. Unrelated regenerated artifacts were restored with `git checkout`.

## Checklist (L side)

| Item | Evidence | Result |
| --- | --- | --- |
| HTTP mocks: text-first image parts with decodable derivative pixels, correct labels, no base64 in XML or text | `inference-observation-turn`: Sharp decodes each data URL as a 320x180 WebP of 256 KiB or less, and the pixel colour matches its source (red and blue in order). Part order and the instruction match the contract exactly. There is no `detail` field and no `input_references`. The source PNG never appears. Text parts and history contain no encoded run and no `data:image`. The fixture's final message is rebuilt exactly from `imageTurnContent`. | PASS |
| Alias moves to image-capable, text-only, missing and cyclic targets; catalogue outage and TTL; custom endpoints | All 10 `qualification_cases`, plus direct-lane tests for each alias case, `reasoning` required only when sent, every fallback required, 3600 s success and 60 s failure TTL with a mocked clock, one GET shared by context window and qualification, and DeepSeek and localhost URLs returning `endpoint_unsupported` with no fetch. | PASS |
| Gateway capability follows the server model when local config differs; overrides and outages | A text-only local catalogue with the gateway saying `qualified` gives supported with the gateway bounds and no catalogue fetch. The reverse case also holds. Network error, 401, non-JSON and `version:2` each give unavailable for 60 s. The server's `catalog_unavailable` ttl is honoured. The flag off means no request. | PASS |
| No expensive fallback or second interpretation pass | One observer call per turn. The only resend is the contract's single text-only resend after `media_request_invalid` (2 chat calls, the second all string content). | PASS (L side) |
| Text-only fixtures, role normalization, no image refs in later history, summaries or compression | Existing suites pass unchanged. With inference off, the request body is byte-identical (string equality) whether or not the event had media refs. The next observation request after an image turn has only string content. History is always strings. | PASS |
| Single and multiple observations, multiple source events, invalid labels, merged rows | Covered by `parser-outcomes.json` (all cases), plus end-to-end tests: explicit refs on two rows, single observation with omitted labels, multiple observations with omitted labels (images stay event-level), invalid and unknown labels with no fallback and no label text in logs, skip, and a two-event batch storing event labels. | PASS |
| Crash after the local observation write; synced native row merge; overflow | Making `confirmClaimedMessages` throw leaves links and `result_state='stored'` committed, and a replayed ingest returns `already_processed` with no new chat call. Exact-duplicate merge into a synced row keeps the old ref and other keys, bumps rev `7`→`8`, clears `synced_at` and notifies sync. An identical re-link changes nothing. A replica row is untouched. A full 32-ref row sets `overflow:true` and adds no junction. An invalid manifest is never overwritten. | PASS |
| Requested suite (openrouter-messages/provider, context-window, history-pruning, parser) | 87 pass, 0 fail | PASS |
| `bun test tests/media tests/worker/http/routes/media-routes.test.ts` (includes the contract test) | 164 pass, 0 fail | PASS |
| Phase 2 regression command | 370 pass, 0 fail (47 files) | PASS |
| Response processor, Codex batch, history-append and Gemini suites | 104 pass, 0 fail | PASS |
| `npm run typecheck` / `npm run build` | Both exit 0. `sharp` is not statically bundled. | PASS |

Wide sweep (`tests/worker tests/services tests/cli tests/server tests/sdk` plus
Gemini and history-pruning): 3012 pass, 2 fail.
- `field-deadline-wire` also fails on a clean checkout of `4967cb463`. I checked this in a temporary worktree under `.scratch/` and then removed it.
- The other failure is the cross-file mock-pollution "unhandled error between tests" that Phase 2 already recorded.

## Contract decisions and notes

- **Label grammar defect (resolved by the orchestrator).** `parser-outcomes.json` originally expected `unknown_label` for `EVENT1_IMAGE1` and `event1_image9`, but those labels fail the doc grammar. The orchestrator amended the fixture identically in both repos to the grammar-first rule. The implementation applies the doc regex first, and the tests assert the amended fixture with no shim.
- **Revision bump for fresh rows.** A row inserted in the same transaction gets its manifest without a `sync_rev` bump, because it has never emitted a revision and its first sync carries the manifest. Every pre-existing native row whose manifest changes is bumped.
- **Replica rows.** Replica rows (`origin_device_id` set) are never written. Their refs stay event-level (`media_event_refs`) with no junction, so the "junctions exactly match the manifest" rule holds.
- **Gateway cache key.** Gateway capability is cached by base URL plus a SHA-256 of the key, a superset of the contract's "keyed by base URL".
- **Text-only fallback writes no manifest.** A text-only turn (disabled, unqualified, unreadable derivatives, or a gateway 400) writes no manifest or junction. It still records `media_events.result_state`. Images stay in `media_event_refs` as uninspected.
- **Schema version.** Schema version 62 is recorded inside `ensureMediaSchema`. All DDL is `IF NOT EXISTS`, the same pattern as v61.

## Verification fixes

Fixes for the orchestrator's verification, which found a failure in probe
`.scratch/verify4/probe.test.ts` P1. Each fix has a regression test in the
`verification fixes` block of `tests/media/inference-observation-turn.test.ts`,
or in `inference-capability.test.ts` where noted.

1. **(HIGH) A link-write failure rolled back the durable event result.**
   - `writeMediaEventResults` now runs in the outer `storeObservations` transaction, with the observation rows. Only the manifest and junction writes run in the savepoint.
   - When the savepoint fails, the observation and `result_state='stored'`/`media_event_results` still commit, and the images stay event-level and uninspected.
   - The failure is logged at error level with `{sessionId, code}` only.
   - Probe P1 before the fix: `resultState: unprocessed`, `eventResults: 0`, and the replay was re-queued. After the fix: `{"chatCalls":1,"observations":1,"links":0,"manifest":null,"resultState":[{"result_state":"stored"}],"eventResults":1,"confirmed":1}`, the replay returns `already_processed`, and `requeued 0`.
   - Regression test: a trigger aborts `observation_media_links` inserts. The test checks that the observation and event result are stored, that the error log is code-only (`SQLITE_CONSTRAINT_TRIGGER`, no message text), and that replay makes no second chat call.
2. **(LOW-MED) A skip whose result write failed was still confirmed.** `recordSkippedMediaEvents` now propagates the error, so the batch is not confirmed while its events are still unprocessed. Regression test: a trigger aborts the `media_events` update, the turn rejects, `confirmed` is 0 and the state stays `unprocessed`.
3. **(LOW-MED) Request body bound.**
   - `PreparedTurnMedia.maxBodyBytes` is the smaller of the capability's `max_body_bytes` and 4 MiB. It is carried to the provider in a `TurnImageRequest`.
   - `fitTurnImagesToBody` measures the serialized request body (`Buffer.byteLength`) and keeps each image, in request order, only if the body still fits. The image instruction lists only the kept labels.
   - The provider reports `deliveredImageLabels`. The response context is re-frozen with only those images, so an image left out never links or counts as inspected.
   - Image token cost is provider-specific, so the debug log reports an `images` count rather than a token estimate.
   - Regression tests: a gateway bound of 1 byte sends text-only with no links, and the unit test keeps images 1 and 3 when image 2 is too large.
4. **(LOW) Parameters actually sent.**
   - `localImageTurnParameters` now adds every `CLAUDE_MEM_OPENROUTER_EXTRA_BODY` model parameter on openrouter.ai.
   - It excludes protected keys and the request options `provider`, `transforms`, `route`, `usage`, `plugins`, `user`, `session_id` and `models`, none of which the Models API lists in `supported_parameters`.
   - The `max_completion_tokens` compatibility retry is disabled for image requests. If the provider demands it, that is treated as an image-request rejection and the turn is resent text-only, so `max_completion_tokens` is never sent with images.
   - Regression tests in `inference-capability.test.ts` (parameter sets; an extra `top_p` disqualifies, `provider` does not), plus an end-to-end test of the compatibility error on an image turn.
5. **(LOW) Leftover claimed events.** The frozen turn events are *attributed*: they get this turn's observation rows. Other claimed events with media keys are *unattributed*: they get `result_state='skipped'` and no `media_event_results` rows. Regression test included.
6. **Contract wording.** The doc now says new refs are appended in the order the observation lists them. No code change was needed.
7. **(LOW) Cleanup.**
   - Removed the unused `ImageCapability.resolvedModel` and `MediaLinkageWriteResult.invalidManifestRows`.
   - The per-request image cap now uses `LOCAL_IMAGE_REQUEST_BOUNDS.max_images_per_request`.
   - New code-only logs:
     - skipped non-WebP derivatives (`unsupported_format`) and oversize ones (`image_too_large`);
     - refs dropped because the source event no longer retains them (`media_not_found`);
     - replica refs left at event level (`unauthorized_owner`);
     - gateway capability failures (`gateway_http_status`, `gateway_malformed_response`, `gateway_timeout`, `gateway_network_error`), raised from debug to warn.

Verification after the fixes:

| Check | Result |
| --- | --- |
| Requested suite (openrouter-messages/provider, context-window, history-pruning, parser) | 87 pass, 0 fail |
| `tests/media` + media-routes | 172 pass, 0 fail |
| Phase 2 regression command | 370 pass, 0 fail |
| `tests/worker/agents`, Codex batch and provider, history-append, Gemini, token-compatibility | 153 pass, 0 fail |
| Probe `.scratch/verify4/probe.test.ts` | 2 pass |
| `npm run typecheck` / `npm run build` | Both exit 0. Unrelated regenerated plugin files were restored. |

## Unmet or deferred

- The P-side items (gateway endpoint, validator, hook caller, Pro linkage and replay) are not part of this repository.
- Only OpenRouter turns materialize images. Gemini, Codex, OpenAI-compatible and Claude providers stay text-only, but they still record the durable event result when the claimed batch carries media event keys.
- The OSS server-runtime `/v1/events` path is unsupported, as frozen.
- "Insufficient drain budget leaves work retryable" and "media resolution uses only remaining budget" (plan item 7) are not implemented locally. Derivative reads are local file reads within the existing turn. No separate media time budget was added.
- No live image-quality evaluation was run, and no qualified-model claim is made (Phase 7).
- The capture-matrix doc rows still need a coordinated L/P update when a lane is enabled.
