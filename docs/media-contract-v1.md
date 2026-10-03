# Observation media contract v1

Capture and inference are independent and off by default. Phase 1 freezes these
contracts and builds fixtures; it does not qualify a model or enable a provider.
The local `src/shared/media-contract.ts` and Pro `src/lib/media/contract.ts`, and
their golden JSON fixtures, must remain byte-identical.

`metadata.cmem_media_v1` contains `{version:1,attachments:[{id,label,inspection}]}`
with optional `overflow:boolean`. IDs are canonical lowercase random UUIDv4s.
Labels are ASCII letters, digits, `_` or `-`, at most 64 characters, and must
start with a letter or digit. Labels are deterministic per event/request, such
as `event1_image1`; they contain no filename, locator, caption, or user text.
Each ID is unique within a manifest; labels may repeat across merged events.
Each link's inspection is `inspected` or `uninspected`. Storage readiness is
resolved through the media service, never through this metadata. Unknown keys,
duplicate IDs, malformed labels, and unsupported versions fail closed. Other
metadata namespaces remain unchanged when this namespace is integrated later.

A row retains at most 32 refs and at most 8192 encoded manifest bytes. On merge
overflow, retain old refs, leave additional refs on the durable source event,
and set `overflow:true`. An image is inspected only after its pixels were sent
in the accepted request and valid output was linked to it. Capture, text-only
fallback, parse failure, and capability loss leave inspection uninspected.

The separate private provenance validator accepts platform/event identity,
source shape, JSON pointer, zero-based image ordinal, source SHA-256, recipe,
and optionally an explicit trusted local file locator. It contains no source
bytes. A provenance validator does not authorize reads: authenticated ownership
must be checked before any owner-only detail, conversion, upload, or media read.
Private locators, object keys, and event identity do not enter generic feeds,
prompts, canonical metadata, logs, analytics, or sync. A rejected/failed/disabled
descriptor has a version, state, safe error code, uninspected state and optional
label; it never includes an arbitrary decoder exception message.

| Bound | Frozen v1 value |
| --- | --- |
| Images per event | 4 |
| Accepted source and canonical WebP | 3 MiB each |
| Decoded pixels | 24,000,000 |
| Either source dimension | 8192 |
| Conversion admission | One active conversion, fail busy immediately |
| Conversion deadline | 5 seconds total metadata and both encodes |
| LLM derivative | 256 KiB; longest edge 1536; full frame |
| Local encoded inline image bytes | 4 MiB aggregate; event JSON still below existing 5mb cap |
| Gateway decoded image bytes | 1 MiB aggregate, at most four derivatives |
| Upload body | 3 MiB source plus at most 64 KiB multipart overhead |
| Initial owner quota | 256 MiB converted assets, atomically reserved |
| Manifest / provenance | 8192 UTF-8 bytes each |
| Owner-only local locator | 4096 characters |

Reject any source or result that cannot meet these bounds. No adaptive quality
loop, semantic cropping, or automatic content classification is in v1.
Recipes are explicit caller choices: `screenshot-v1` uses lossless canonical
WebP and a near-lossless quality 90 derivative; `photo-v1` uses quality 90 for
both variants. Alpha is preserved. Both remove metadata, auto-orient
and produce retained canonical and inference derivatives. Store recipe and
actual `sharp.versions` encoder version with every conversion.

An actual platform tool-use/event ID defines event identity when available.
The fallback is the tuple `(transcript_id,record_index,record_sha256)` for a
fixture-proven immutable transcript record. The replay key is SHA-256 over a
canonical JSON tuple of version, platform, event identity, source pointer,
source SHA-256 and recipe. Generate a random attachment UUID only on the first
successful insert for that key. Database uniqueness, not a RAM buffer, resolves
concurrent attempts. Never use RAM IDs, mutable prompt numbers, current time,
or filename alone as identity. Identical images in different events retain
distinct event provenance; any asset dedupe is owner-local and reference-aware.

| Native source shape | Fixture evidence | Capture support in Phase 1 |
| --- | --- | --- |
| Anthropic `image.source.data` / `media_type` | Existing local image-strip live-path fixtures | Candidate, capture implementation still disabled |
| Claude Read `image.file.base64` | Existing local Read fixture | Candidate, capture implementation still disabled |
| MCP `image.data` / `mimeType` | Existing local MCP fixture | Candidate, capture implementation still disabled |
| OpenAI `image_url.url` data URL | Existing local OpenAI fixture | Candidate, capture implementation still disabled |
| Explicit Read/tool local file contract | Read input fixture only | Requires path, symlink, size and identity proof before capture |
| Codex/Cowork prompt attachment, provider-private asset | No fixture-backed capture implementation | Unsupported |
| Bare path-like strings or placeholders | No typed bytes/locator contract | Unsupported |
| Remote image URL; SVG/PDF/video/animated image | Outside v1 contract | Unsupported |

Accepted media source types are PNG, JPEG and WebP only. Native shape evidence
does not prove every platform's capture coverage. Phase 2/5 must update this
matrix with the exact active adapter, fixture and privacy gate before enabling
each lane. `submittedPrompt:null` is never interpreted as image bytes.

Converter APIs copy the documented [Sharp constructor](https://sharp.pixelplumbing.com/api-constructor/),
[metadata](https://sharp.pixelplumbing.com/api-input/),
[output](https://sharp.pixelplumbing.com/api-output/),
[resize](https://sharp.pixelplumbing.com/api-resize/) and
[auto orientation](https://sharp.pixelplumbing.com/api-operation/) calls:
`sharp(bytes,{failOn:'warning',limitInputPixels:24000000})`, `metadata()`,
`autoOrient()`, `resize({width:1536,height:1536,fit:'inside',withoutEnlargement:true})`,
`webp(options)`, `timeout({seconds:5})`, `toBuffer({resolveWithObject:true})`.
Header metadata is not decoding proof. Output removes EXIF/GPS by default;
never call `keepMetadata()`/`withMetadata()`. Sharp timeout excludes time in
the native worker queue, so the application deadline starts before metadata.
Hold the concurrency slot until native work settles even if the caller times
out. A wall-clock promise timeout cannot cancel libvips by itself.

[Sharp installation](https://sharp.pixelplumbing.com/install/) requires a
Node-API v9 runtime and platform-native Sharp/libvips packages. Keep Sharp
external in the local worker bundle, declare it in runtime package sources,
and exercise the converter through fresh plugin and packed npm installs.
Pro declares it directly rather than relying on Next's transitive copy. Test
the production server bundle as well. macOS arm64 and Docker Linux are
available in this execution environment; actual results are recorded in the
Phase 1 handoff. Windows x64 compiled worker native invocation remains a
required gate until a Windows runner proves it. Cross-compilation or a
source-checkout import does not satisfy that gate.

[OpenRouter image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding)
use text-first `text` and `image_url` content parts; private derivative bytes
are WebP data URLs only at the provider boundary. Image count varies by model
and provider. Model architecture comes from the [Models API](https://openrouter.ai/docs/api/api-reference/models/get-models);
requested parameter support comes from [model endpoints](https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints).
Resolve aliases with cycle/missing-target checks. The current catalog advertises
text/image input for `~deepseek/deepseek-flash-latest` resolving to
`deepseek/deepseek-v4.1-flash`; this is capability evidence, not image-quality
qualification. Preserve Pro's leading `~`, server choice, ignored provider and
[price-first policy](https://openrouter.ai/docs/guides/routing/provider-selection).
Production follows the latest Flash alias under the standing owner rule;
a concrete evaluation candidate is held fixed only for comparable test runs.
Usage accounting is [automatic](https://openrouter.ai/docs/cookbook/administration/usage-accounting):
do not add deprecated `usage.include` or `stream_options.include_usage`.

Cloud provisioning later calls [createBucket](https://supabase.com/docs/reference/javascript/storage-createbucket)
with `public:false`, then [upload](https://supabase.com/docs/reference/javascript/storage-from-upload)
with `contentType:'image/webp',upsert:false`; [download](https://supabase.com/docs/reference/javascript/storage-from-download)
and [remove](https://supabase.com/docs/reference/javascript/storage-from-remove)
use database-owned keys. Service-role calls bypass RLS, so every application
statement needs ownership checks. Never create buckets on ordinary requests or
serve public/persistent signed URLs. [Vercel limits](https://vercel.com/docs/functions/limitations#request-body-size)
both request and response to 4.5 MB; the smaller measured body bound above is
deliberate. Account erasure/quota/upload finalization must later be serialized
against the durable erasure marker.

API error names are the closed `MEDIA_ERROR_CODES` enum. Format/magic mismatch,
animation, invalid pixels, dimensions/pixels/byte bounds and timeouts reject
conversion; unavailable decoder, busy admission, storage outage and disabled
flags remain explicit. Owner/quota/deleted-account checks fail before pixels
are read. Route-specific HTTP mapping will be wired with the route phases;
arbitrary decoder/storage exception text must not be returned to clients.

The evaluation corpus contains generated synthetic fixtures and an attributed
NASA Apollo 17 photograph; no private user screenshots.
Critical facts and expected attachment labels are grading data, never model
prompt data. The Phase 1 harness defaults to dry run with zero calls and has
an injected caller only. Its explicit execution path requires spend, retry,
output-token and per-request estimate bounds, uses one request at a time, and
records returned metering provenance before another call. A bounded request
deadline stops unknown-charge attempts and retains the execution slot until the
caller settles. Live callers require a durable attempt recorder. An unknown charge stops the run. An
estimate does not guarantee the final in-flight charge fits: record actual
overrun and stop immediately. Dry-run/mock success is never model qualification.
Every execution receives a random UUID run ID by default; an explicitly supplied
run ID is a bounded opaque unique execution nonce, never a path or user text.
