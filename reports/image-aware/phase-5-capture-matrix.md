# Phase 5 capture matrix (L): prompt, transcript and tool-result media

Repository L, branch `feat/image-aware-observations`. This matrix records which
platform events can carry captured images into observations, based on the
active adapters and existing fixtures. A lane is listed as supported only when
it has an actual platform tool-use/event ID and a fixture-backed native shape.
Everything else is unsupported in v1 and stays text-only. Capture stays off by
default behind `CLAUDE_MEM_MEDIA_CAPTURE_ENABLED`.

The frozen `docs/media-contract-v1.md` table still reads "capture
implementation still disabled". That doc must stay byte-identical with Pro, so
this matrix is recorded here instead of editing it. A coordinated L/P doc
update is still needed before a lane is enabled publicly.

## Capture seam

All tool-result media enters through one seam: `ingestObservation` in
`src/services/worker/http/shared.ts`, which calls `captureObservationMedia` in
`src/services/media/capture.ts`. Capture runs after the exclusion, skip,
subagent and privacy gates and before serialization. Hooks and the transcript
watcher (`src/services/transcripts/processor.ts` `sendObservation`) both call
this seam. The event identity is the platform tool-use ID, namespaced as
SHA-256 of `(platform, contentSessionId, toolUseId)`. Platform mapping is in
`provenancePlatformOf`: `claude` maps to `claude-code`, and `codex` and
`cowork` map to themselves. Any other platform, or an event without a
tool-use ID, gets the `unsupported_source` descriptor and stays text-only.

## Matrix

| Platform / adapter | Event | Media source forms | Identity | Status |
| --- | --- | --- | --- | --- |
| Claude Code hooks (`src/cli/adapters/claude-code.ts`) | PostToolUse tool result | Anthropic `image.source.data`, Claude Read `image.file.base64` (real `file.type` shape), MCP `image.data` (also inside JSON text), OpenAI `image_url` data URL, typed Read file locator (path equals `tool_input.file_path`, inside `cwd`, regular non-symlink file, 3 MiB or less) | `tool_use_id` | Supported behind the flag. Fixtures: `tests/media/capture.test.ts`, `tests/media/ingress.test.ts`, `tests/worker/observer-image-strip-live-path.test.ts` |
| Codex hooks (`src/cli/adapters/codex.ts`) | PostToolUse tool result | Same native shapes, when present in the tool response | `tool_use_id` | Shape-supported through the same seam. No Codex-native image fixture exists, so this is not proven against a real Codex image payload |
| Codex transcript watcher (`transcript-watch.example.json` `codex` schema, `processor.ts`) | `tool-use` / `tool-result` / `exec-command-end` records | Same native shapes, when present in `toolResponse` | Transcript `toolId` (the `call_id`), passed as `toolUseId` | Shape-supported through the same seam. No Codex transcript image fixture exists, so this is not proven |
| Cowork worker-side (`platformSource` `cowork` through the local seam) | Tool result | Same native shapes | Platform tool-use ID | Shape-supported, no Cowork image fixture |
| Cowork hook client (`cowork/scripts/cmem-hook.mjs` `onObservation`, Pro-side ingest) | PostToolUse tool result, raw `tool_response` object before `clean()` | Anthropic, Claude Read (at the root, `/tool_response`), MCP `image.data`+`mimeType` inside objects or arrays, OpenAI data URL. PNG/JPEG/WebP magic bytes, at most 3 MiB, first 4 in document order. MCP results carried as JSON *strings* are not parsed (the local worker scanner does parse them) | `tool_use_id` matching the contract opaque-ID grammar, as `{kind:'platform_event'}` with platform `cowork` | Implemented behind `capture.media` / `CMEM_MEDIA_CAPTURE_ENABLED` / `CLAUDE_MEM_MEDIA_CAPTURE_ENABLED` (off). Upload comes before the first staging. Failure stages text-only once. Uploads unconverted source bytes with `encoder:'source'` per Pro's Phase 5 spec. **Not enableable yet:** no native Cowork PostToolUse image fixture exists. Tests use the shapes of the local native fixtures with generated pixels (`tests/cowork/cmem-hook-media.test.ts`) |
| Cursor, Kimi, Windsurf, Antigravity, raw adapters | Tool result | Any | They supply a tool ID, but the platform is not in `provenancePlatformOf` | Unsupported: `unsupported_source`, text-only |
| Any platform: user prompt (`UserPromptSubmit` → `src/cli/handlers/session-init.ts`) | Prompt submission | None: the normalized hook input carries only `prompt` and `submittedPrompt` text | None | **Unsupported.** No fixture shows prompt image bytes or a typed attachment in any adapter's hook payload |
| Transcript `user-message` records (`processor.ts`, `resolveMessageText`) | User turn in a transcript | Text only: images in message parts are not extracted | None | **Unsupported.** No fixture-proven immutable transcript record exists, so the contract's `(transcript_id, record_index, record_sha256)` fallback identity stays reserved and unimplemented |
| Codex/Cowork prompt attachments, provider-private asset references | Prompt | Platform-private asset IDs | None | **Unsupported** (contract v1). Platform-private assets are never fetched |
| Bare paths, placeholders, remote URLs, SVG/PDF/video/animation | Any | n/a | n/a | **Unsupported** (contract v1) |

## `submittedPrompt:null` semantics

Unchanged. `session-init.ts` returns before storing a prompt when the host
reports `submittedPrompt === null` (a continuation, retry or tool-result send).
The `[media prompt]` placeholder is used only for a genuinely empty
user-submitted turn, and it is never interpreted as image bytes. No prompt
media capture was added, so no privacy gate changed. Regression:
`tests/cli/handlers/session-init-submitted-prompt.test.ts` (run in the Phase 5
handoff).

## What would enable an unsupported lane

1. A captured, scrubbed native fixture of the actual platform payload: the
   prompt hook or transcript record that contains the image, with generated
   pixels.
2. A stable platform event ID, or a proven immutable transcript record for the
   `transcript_event` identity.
3. A new adapter mapping in `provenancePlatformOf` and the
   `MediaProvenance.platform` enum. That enum is frozen contract text, so
   adding a platform needs a coordinated L/P contract change.
4. Privacy-gate review for prompt text. `<private>` stripping currently runs on
   text only.
