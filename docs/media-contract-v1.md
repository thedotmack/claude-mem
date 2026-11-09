# Observation media contract v1

Capture and inference are independent. In claude-mem, capture
(`CLAUDE_MEM_MEDIA_CAPTURE_ENABLED`, the viewer's "Keep images" switch) is on by
default and inference is off by default. Pro's `CMEM_MEDIA_*` operator flags are
off unless an operator sets them. Phase 1 freezes these
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
A present `metadata.cmem_media_v1` whose value is `null` is invalid and
rejected; omit the key when there are no refs. `attachments:[]` is valid and
is an explicit empty ref set.

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
| Accepted source and canonical WebP | 3 MiB each: the bound for an upload Pro accepts and for reading a stored canonical, including one stored before every copy became lossy (lossless, up to 3 MiB). Local worker: a file source up to 96 MiB is accepted (see below) |
| Encoded canonical WebP | 1 MiB (`maxEncodedCanonicalBytes`). Each converter fits every canonical it encodes into it; see "Recipes" for the measurement |
| Decoded pixels | 24,000,000. Local worker: decodes up to 268,402,689 (16383 x 16383) and fits the canonical to 24,000,000 |
| Either source dimension | 8192. Local worker: fits the canonical to 8192 instead of rejecting |
| Conversion admission | One active conversion. Pro upload route: fail busy immediately. Local worker: wait up to 20 seconds for the slot, first come first served, then fail busy |
| Conversion deadline | Pro upload route: 5 seconds. Local worker: 20 seconds. Either covers metadata and every encode, including any shrink round |
| LLM derivative | 256 KiB; longest edge 1536; full frame |
| Local encoded inline image bytes | 4 MiB aggregate; event JSON still below existing 5mb cap |
| Gateway decoded image bytes | 1 MiB aggregate, at most four derivatives |
| Upload body | 3 MiB source plus at most 64 KiB multipart overhead |
| Owner quota | 25 GiB converted assets, atomically reserved. Pro enforces it (uploads past it answer 413 `quota_exceeded`); the value matches Pro's contract |
| Manifest / provenance | 8192 UTF-8 bytes each |
| Owner-only local locator | 4096 characters |

Pro rejects any source that cannot meet these bounds. An encode over its byte
ceiling (1 MiB canonical, 256 KiB derivative) is shrunk to fit on both sides,
never rejected; the local worker also fits a source over the dimension and
pixel bounds (see "Where the size bounds apply"). No semantic cropping or
automatic content classification is in v1.

### Recipes

Every stored copy is lossy WebP. Nothing is encoded lossless or near-lossless.
Reason: the owner's rule of 2026-11-05/06, "screenshots never need to be
multiple megabytes" and "never lossless".

Recipes are explicit caller choices: `screenshot-v1` encodes both variants as
lossy WebP quality 80; `photo-v1` encodes both as quality 90 (unchanged).
There is no quality retry: a variant over its byte ceiling is shrunk with the
same setting. The recipe name and the manifest version do not change; a
canonical stored before this rule may be lossless and up to 3 MiB, and it is
never re-encoded or deleted for that.

Evidence for quality 80 and the 1 MiB canonical ceiling, 2026-11-06: the 29
real screenshots from a developer's Mac (62 KiB to 4.0 MiB PNG, 626x333 to
2880x6716), Sharp 0.35.5, one libvips thread:

| Copy | Before (lossless / near-lossless 90) | Quality 90 | Quality 80 (chosen) |
| --- | --- | --- | --- |
| Canonical, median / largest | 170 KiB / 2031 KiB | 113 KiB / 514 KiB | 80 KiB / 406 KiB |
| Canonical CPU, median / largest | 0.76 s / 5.29 s | 0.21 s / 0.89 s | 0.20 s / 0.85 s |
| Derivative, median / largest | 153 KiB / 872 KiB | 74 KiB / 172 KiB | 54 KiB / 121 KiB |

- Text stays readable at 1:1 in both copies at quality 80, checked by eye on
  dark UI, a light terminal and colored monospace text. Quality 90 costs about
  1.4 times the bytes for no readable difference.
- The 1 MiB canonical ceiling keeps all 29 at full resolution, with about 2.5
  times headroom over the largest (406 KiB). A 2800x23880 full-page screenshot,
  fitted to 8192 px, is 528 KiB. 1 MiB is not "multiple megabytes".
- Pro re-encodes the uploaded canonical at the same setting. Measured on the
  same 29, that second quality 80 encode was at most 0.995 times the first, so
  it fits the same ceiling; if one does not, Pro shrinks it like the local
  worker.
- Lossy is larger than lossless for a few small flat screenshots (a 925x927
  Linux terminal: 35 KiB lossless, 103 KiB at quality 80). Every such case
  measured stays far under the ceilings.

Alpha is preserved. Both recipes remove metadata, auto-orient and produce
retained canonical and inference derivatives. Store recipe and actual
`sharp.versions` encoder version with every conversion.

### Where the conversion bounds apply

Pro's upload route and the local worker convert on different machines, so the
admission and deadline rows have one value for each. Every other bound is the
same on both. `MEDIA_LIMITS.conversionTimeoutSeconds` (5) and
`maxConcurrentConversions` (1) stay as they are in the shared contract file.
The local values live in the local converter
(`LOCAL_CONVERSION_DEADLINE_MS`, `LOCAL_ADMISSION_WAIT_MS`).

- Pro upload route: 5 second deadline, one active conversion, fail busy at
  once. Reason: shared server instances and the route's 59 second budget.
  Unchanged.
- Local worker: 20 second deadline, one active conversion, and a caller waits
  up to 20 seconds for the slot (first come, first served) before it fails
  `conversion_busy`. The deadline starts when the caller gets the slot.
  Reason: the local worker converts off the hook path (the PostToolUse hook
  writes a spool file and returns, and the worker converts while it drains the
  spool), so no agent waits on it. A conversion runs on about one core. On
  2026-11-05, 27 real screenshots from a developer's 10-core Mac needed 2.1 to
  4.3 seconds each when typical, and 5.8 seconds for the slowest (2880x6716).
  With the 5 second deadline and fail-at-once admission, run back to back as
  the spool drain runs them, 11 of the 27 converted: the slowest timed out,
  and the next 15 failed busy while its native work finished. Under load
  average 30 to 50, 11 of the 27 needed over 5 seconds even alone, and none
  of the 27 converted. With the local bounds all 27 converted in both cases
  (slowest 16.4 seconds under load), and all 81 converted when three callers
  ran the 27 at once. A local conversion row's lease covers the wait, the
  deadline and two SQLite busy waits, so cleanup never fails a live one.

Both converters hold the slot until native work settles. The local converter
gives each native step only the deadline time still left, rounded up to whole
seconds (Sharp's unit), so a conversion that timed out holds the slot for at
most about one more second.

### Where the size bounds apply

On a user's computer no image is thrown away for size when the decoder can read
it safely. The local worker uploads only its canonical WebP to Pro, so a
canonical that fits the canonical bounds is what Pro receives. Pro's own
upload route still rejects a source over a bound.

- File source (a Read of a local image file): up to 96 MiB. Reason: abuse
  protection on worker memory, because the file is read whole. Screenshot PNGs
  measured about 0.32 bytes per pixel (a 2800x23880 full-page screenshot was
  20.4 MiB), so a screenshot at the decoder bound below is about 82 MiB.
- Inline source (image bytes inside the tool response): still at most 4 MiB
  of base64 for the event, because the event JSON must stay under the
  existing 5 MB cap (the worker's JSON body limit). An inline image over that
  is replaced by a `source_too_large` descriptor at the hook. Not changed in
  this step.
- Decoder: up to 268,402,689 pixels (16383 x 16383), Sharp's own default
  `limitInputPixels`, its decompression-bomb guard. Over that the image fails
  `pixel_limit`. Measured: fitting a 16383x16383 PNG took 0.9 seconds and
  512 MiB of memory; a 66.9 million pixel full-page screenshot took 4.5
  seconds and 324 MiB.
- Canonical over 8192 on a side or over 24,000,000 pixels: resized, full
  frame, to fit both.
- Canonical over 1 MiB, or a derivative over 256 KiB, after its recipe's
  encode: the longest edge is shrunk so the pixel count scales by the byte
  overshoot, aiming 10% under the ceiling, with the recipe's setting, until
  it fits. Every round shrinks the image, and the conversion deadline bounds
  the rounds. Pro's converter shrinks the same way.
- Evidence, 2026-11-05: of 29 real screenshots from a developer's Mac, the old
  bounds rejected 2 for source size (3.3 MiB and 4.0 MiB). With the local
  bounds all 29 convert. On 2026-11-06, at quality 80, those two keep full
  size as 81 KiB and 202 KiB canonicals (they were 1363 KiB and 2031 KiB
  lossless).

An actual platform tool-use/event ID defines event identity when available.
The fallback is the tuple `(transcript_id,record_index,record_sha256)` for a
fixture-proven immutable transcript record. The replay key is SHA-256 over a
canonical JSON tuple of version, platform, event identity, source pointer,
source SHA-256 and recipe. Generate a random attachment UUID only on the first
successful insert for that key. Database uniqueness, not a RAM buffer, resolves
concurrent attempts. Never use RAM IDs, mutable prompt numbers, current time,
or filename alone as identity. Identical images in different events retain
distinct event provenance; any asset dedupe is owner-local and reference-aware.
Lanes key images differently, so identity is lane-scoped. The Cowork hook
lane keys images by `(platform, tool_use_id)`. The local worker lane keys them
by its session-scoped event key. The same tool use captured by both lanes is
stored twice; this duplicate storage is known and accepted in v1.

| Native source shape | Fixture evidence | Capture support in Phase 1 |
| --- | --- | --- |
| Anthropic `image.source.data` / `media_type` | Existing local image-strip live-path fixtures | Candidate, capture implementation still disabled |
| Claude Read `image.file.base64` | Existing local Read fixture | Candidate, capture implementation still disabled |
| MCP `image.data` / `mimeType` | Existing local MCP fixture | Candidate, capture implementation still disabled |
| OpenAI `image_url.url` data URL | Existing local OpenAI fixture | Candidate, capture implementation still disabled |
| Explicit Read/tool local file contract | Read input fixture only | Requires path, symlink, size and identity proof before capture |
| Codex/Cowork prompt attachment, provider-private asset | No fixture-backed capture implementation | Unsupported |
| Cowork hook client PostToolUse tool result (Phase 5) | Shapes of the local native fixtures with generated pixels; no native Cowork fixture | Anthropic, Claude Read, MCP `image.data` (not JSON strings) and OpenAI data URL shapes per the Phase 5 capture matrix; disabled by default; requires a real native Cowork fixture before enablement |
| Prompt or transcript message media (any platform) | No fixture-backed prompt/transcript image shape | Unsupported in v1 |
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
`webp(options)`, `timeout({seconds:5})` (local worker: the seconds left of its
20 second deadline), `toBuffer({resolveWithObject:true})`.
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

Pro observation-media upload (Phase 5) accepts a canonical source image of
type `image/png`, `image/jpeg` or `image/webp`. The type is verified by magic
bytes, the source is at most 3 MiB, and the same decoder limits apply. Such an
upload declares manifest encoder `source` and is converted server-side. Stored
objects are only the WebP viewer and LLM variants; the source is never stored.
The local worker uploads Sharp-converted WebP and declares encoder
`sharp-x/vips-y` with its actual Sharp and libvips versions.

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

## Phase 4 — inference and linkage

This section freezes the inference request, observation linkage, capability
and gateway validation contracts. Golden fixtures live in
`tests/fixtures/media-v1/inference/` and must stay byte-identical in both
repositories. `scripts/media/contract-checks.ts` checks them against
`MEDIA_LIMITS`. The checks do not implement any behavior described here.

### Request image parts

Images are sent only on the current observation turn. They are never sent on
summary, wrap-up, compression or condensation requests, and never added to
history. History and every earlier message keep their existing string
`content`. After history assembly, anchoring and same-role coalescing, only the
final user message changes from a string to this ordered array:

1. `{type:'text',text:<the existing turn string, unchanged>}`
2. `{type:'text',text:'Images attached to this turn: <L1>, <L2>. Each image follows a line [image LABEL]. In each <observation> informed by an image, list the label inside <attachments><attachment>LABEL</attachment></attachments>. Use only these labels.'}`
   Labels are joined with `, ` in request order.
3. For each image in request order, `{type:'text',text:'[image <label>]'}`
   followed immediately by `{type:'image_url',image_url:{url:'data:image/webp;base64,<derivative>'}}`.

Text comes first, as [OpenRouter recommends](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding).
Only the retained LLM derivative (WebP, at most 1536 px on the longest edge
and 256 KiB) is sent. The source and canonical bytes are never sent. Send no
`detail` field and no top-level `input_references`. A request with no images
is byte-identical to today's request. The observation skeleton,
`OBSERVATION_SCHEMA_REMINDER` and text-only prompts do not change. Only
instruction 2 introduces `<attachments>`.

A request label is `event<E>_image<N>`. `E` is the 1-based position of the
source event within this request (a batch has several events). `N` is the
ordinal from that event's stored label `event1_image<N>`. The worker freezes
the map from request label to `(event_key, attachment_id, event_label)` in the
per-turn response context when it sends the request. It never re-derives the
map from mutable session state. Manifests and junction rows store the event
label, not the request label, so an image keeps one label however it was
batched.

| Per-request bound | Frozen value |
| --- | --- |
| Images, all messages | 4 |
| Decoded bytes per image | 262,144 |
| Aggregate decoded image bytes | 1,048,576 (4 x 262,144) |
| Data URL characters per image | 349,551 (23-character prefix + 349,528 base64) |
| Aggregate image data URL characters | 1,398,204 (4 x 349,551) |
| Gateway request body | 4,194,304 bytes |

The two aggregate bounds equal four times the per-image bounds. A validator
that enforces the count and per-image bounds therefore enforces the aggregates
too, and there is no separate aggregate rejection reason. When a turn has more
than four eligible images, the first four in event order and then ordinal
order are sent. The others stay uninspected on their source event. Callers
mirror the gateway validator before sending, so a gateway rejection means a
client bug. Fixture: `request-two-images.json`.

### Observation XML attachment refs

Inside `<observation>`, the optional element is
`<attachments><attachment>LABEL</attachment>...</attachments>`. Tags are
lowercase and matched case-sensitively in both parsers. The local parser
matches its existing tags case-insensitively, but must not do so for this
element. Only the first `<attachments>` block in an observation is read. Each
element's text is trimmed and must match `^event[1-9][0-9]{0,2}_image[1-4]$`.
The `<observation>` root takes no attributes, because both existing parsers
match only a bare `<observation>`.

Linkage rules, applied per accepted response. Fixture: `parser-outcomes.json`.

- Only the first four `<attachment>` elements of an observation are evaluated,
  in document order. Later elements are rejected as `too_many_refs`.
- A label that fails the grammar is rejected as `invalid_label`. A label that
  is not among the labels supplied in this request is rejected as
  `unknown_label`. Comparison is exact and case-sensitive. A repeated label is
  deduplicated, and its first position is kept.
- When an observation's remaining refs span more than one source event, all
  of them are rejected as `cross_event`. Nothing is assigned by picking a
  winner.
- An observation without `<attachment>` elements omits labels. An empty
  `<attachments>` element, or an unrecognized `<Attachments>`, also counts as
  omitted. If the response has exactly one observation, that observation
  omits labels, and every supplied image came from one source event, then the
  observation is linked to all supplied images. In every other case,
  observations that omit labels get no refs.
- An observation that emitted only rejected refs never falls back to implicit
  association.
- One image may link to several observations. In a request that carried
  images, an image that no observation links stays an event-level unassigned
  image and remains `uninspected`.
- `<skip_summary/>`, an invalid response, a text-only fallback or a request
  that was not accepted marks nothing `inspected`. All of its images stay
  uninspected. Observations a text-only fallback stores get capture-only links
  (below), and a turn that stores none hands its images on within its prompt
  (below).

Rejections are recorded only as reason codes, never as label text from model
output. Older parsers ignore the element because field extraction skips
unknown children. In the local salvage path (no title, narrative, facts or
concepts), the new parser strips `<attachments>` like the other schema tags
and does not count it as schema drift. Older clients never get images because
of capability gating, so they never get the instruction.

### Capture-only linkage

When capture retained an event's images and the request did not carry them,
every observation stored from that event's turn links all of the event's
retained images as `uninspected`.

- "Did not carry them" means the accepted request carried none of the turn's
  images: inference is off, the model does not qualify, the turn was resent
  text-only, or no derivative could be read. When the request carried any of
  the turn's images, the linkage rules above apply instead, and images it did
  not carry stay event-level.
- A turn's events are the source events frozen when the request was sent.
  When the request recorded none, they are the source events of every message
  in the confirmed batch.
- An event's retained images are its refs (local `media_event_refs`, or the
  equivalent cloud event refs) while the event is retained, in event label
  order, one ref per attachment ID. An image whose conversion failed or that
  was deleted is not linked.
- The links need no model output. The request does not mention the images,
  and `<attachments>` is not read for them.
- The manifest rules below apply unchanged: union by ID, the 32-ref bound and
  overflow, inspection as the OR of both sides, replica rows left unchanged,
  and the same storage transaction. A later `inspected` link for the same ID
  upgrades the ref.

A turn that stored no observation (`<skip_summary/>`, a reply with no storable
observation, or a batch dropped after an unusable reply) hands its images on
within its prompt:

When a turn attributed image events and stored no observation, those events'
retained images link as `uninspected` to the most recent observation already
stored for the same session and prompt. If there is none yet, they link to the
observations stored by the next turn of that session and prompt that stores
any. If the prompt never stores an observation, they stay event-level.

- This applies whether or not the turn's request carried the images: with no
  stored observation there is no model linkage to keep.
- The turn's events are its attributed events, chosen as above.
- The prompt is the one the turn's request was sent for (the prompt number
  frozen with the response context). The session is the observed session
  (local: the same `sdk_sessions` row). An observation from another prompt,
  even in the same session, never receives these images. A turn with no
  prompt number (local: stored as a NULL `prompt_number`) hands nothing on.
- "Most recent" is the last observation stored for that session and prompt
  (local: the highest `observations.id`). Only that one observation gets the
  links. It was stored by an earlier turn, so a native row whose manifest
  changes gets its `sync_rev` incremented, `synced_at` cleared and sync
  notified; a replica row is left unchanged and the images stay event-level.
- With no such observation yet, the events wait durably, surviving a worker
  restart (local: `media_events.carry_prompt_number`). The next turn of the
  same session and prompt that stores at least one observation links them to
  every observation it stored, in the same storage transaction, whether or not
  that turn has images of its own. Storage can return an existing row (an
  exact duplicate or a title match) that belongs to another prompt or session;
  that row gets none of them, and if no stored row belongs to the prompt, the
  events keep waiting. Waiting images come first, in event order
  then label order, followed by the turn's own refs. Once linked, an event no
  longer waits.
- An event deleted while it waits links nothing. A prompt that never stores an
  observation leaves its waiting images event-level for good.

Fixtures: `manifest-merge.json` `capture_only_links_every_retained_image_uninspected`,
`capture_only_skipped_turn_links_backward_to_most_recent_observation` and
`capture_only_skipped_turn_links_forward_before_turn_refs`.

### Capability qualification

A model qualifies for image inspection only if all of these hold for the
resolved catalog entry from the [Models API](https://openrouter.ai/docs/api/api-reference/models/get-models):

- `architecture.input_modalities` contains `image`.
- `architecture.output_modalities` contains `text`.
- `supported_parameters` contains every OpenRouter parameter the observer
  actually sends on an image turn.

Missing fields fail closed. Required parameters:

- Local worker: `max_tokens` and `temperature`, plus `reasoning` when the typed
  reasoning effort is sent.
- Pro hook caller: `max_tokens` and `reasoning` (sent as
  `{enabled:false}`).
- Gateway: `max_tokens` and `temperature`, the parameters the local worker
  sends.

Alias resolution copies Pro `resolveCatalogModel`. Look up by `id`, then by
`canonical_slug`, and follow `alias_target.slug`. A missing target, a cycle,
or a chain that ends on a `~` id resolves to `model_unresolved`.

A local `CLAUDE_MEM_OPENROUTER_MODEL` with fallbacks qualifies only when the
primary and every fallback qualify, because OpenRouter may route to any of
them. Local direct OpenRouter clients qualify their own configured model.
Local clients pointed at the cmem gateway use only the gateway capability
response, because the server overrides the client model. Any other base URL is
unsupported in v1 and never receives images.

Catalog cache: `GET https://openrouter.ai/api/v1/models` is fetched with one
in-flight request at a time. Successes are cached for 3600 seconds and
failures for 60 seconds, matching the local context-window catalog. The cache
keeps id, canonical_slug, alias_target, architecture modalities and
supported_parameters.

When the capability is unavailable or not qualified, visual inspection is
deferred:

- The turn is sent as today's text-only request.
- The event's images stay retained and `uninspected`, and the turn's
  observations get capture-only links to them (a turn that stores none hands
  them on within its prompt, see "Capture-only linkage").
- `media_events.result_state` follows the text outcome (`stored` or `skipped`).

v1 never re-calls a model automatically to inspect deferred images.
Fixture: `capability.json` `qualification_cases`.

### Pro gateway capability endpoint

`GET /api/inference/v1/capabilities` uses the same authentication as chat
completions:

- A `cm_pro_` bearer checked with `bearerFrom`.
- A `pro_users` lookup.
- `isProActive`.
- The same rate-limit bucket.

Failures return the existing gateway error envelope (`key_invalid` 401,
`subscription_inactive` 402, `rate_limited` 429). Success is HTTP 200 with
`PRIVATE_HEADERS` and exactly these keys:

```json
{"version":1,"requested_model":"<server-selected observer model>","resolved_model":"<concrete id or null>",
 "supports_image_input":true,"reason":null,
 "bounds":{"max_images_per_request":4,"max_image_decoded_bytes":262144,
  "max_aggregate_image_decoded_bytes":1048576,"max_aggregate_image_data_url_bytes":1398204,
  "max_image_dimension":1536,"max_body_bytes":4194304,"image_mime_types":["image/webp"]},
 "qualified_at":"<ISO-8601 catalog qualification time or null>","ttl_seconds":3600}
```

`supports_image_input` is true only when all of these hold:

- `CMEM_MEDIA_INFERENCE_ENABLED` is on.
- The server-selected observer model qualifies.
- The caller is entitled.

The server-selected observer model is the saved selection that chat
completions and the hook caller send (`activeObserverModel()`), without a
`:floor` routing suffix. With `CMEM_MEDIA_INFERENCE_ENABLED` off the flag is
the whole answer: `requested_model` is the environment default
(`observerModel()`, without `:floor`), and no catalog or saved selection is
read. When the saved selection cannot be read, the answer is
`catalog_unavailable` with the environment default.

When it is false, `bounds` is null and `reason` is one of
`inference_disabled`, `model_not_image_capable`, `model_unresolved`,
`missing_parameters` or `catalog_unavailable`. `resolved_model` and
`qualified_at` are null for `inference_disabled` and `catalog_unavailable`.
Otherwise `qualified_at` is the time the cached catalog was fetched.
`ttl_seconds` is 60 for `catalog_unavailable` and 3600 otherwise. The response
never contains a key, token, provider routing or price.

Clients cache the response for `ttl_seconds`, keyed by base URL. They treat a
network error, timeout, non-2xx status, malformed body or unknown `version` as
unavailable for 60 seconds. They do not override `bounds` with local values.
Keys use snake_case to match the OpenAI/OpenRouter wire format and the
gateway's `request_id` envelope. Fixture: `capability.json` `responses`.

### Gateway request validator

These checks run only while `CMEM_MEDIA_INFERENCE_ENABLED` is on. With it
off, the route reads the body with `req.json()` as it did before the media
rollout, so a body over 4 MiB, a text part with extra keys (such as
`cache_control`) and a caller-supplied image part pass unchanged. With it on,
they run in `POST /api/inference/v1/chat/completions` after authentication, in
place of `req.json()`:

1. A `Content-Length` above 4,194,304, or a streamed body that exceeds that
   byte count, is rejected as `body_too_large`. The body is read with the
   existing `readRequestBodyWithinLimit`, and only then parsed.
2. JSON that does not parse is `invalid_json`. A `messages` value that is
   missing, empty or not an array is `invalid_messages`.
3. String `content`, a null assistant `content` with `tool_calls`, and `tool`
   messages pass unchanged. Array content may hold only parts that are
   `{type:'text',text:string}` or `{type:'image_url',image_url:{url:string}}`.
   Anything else, including a top-level `input_references` key, is
   `invalid_content_part`.
4. An image part outside a `user` message is `image_outside_user_message`.
   An `image_url.url` that is not a `data:` URL is `external_image_url`,
   whether it uses http, https or any other scheme. Nothing is fetched.
5. A data URL must be `data:image/(webp|png|jpeg);base64,`. Otherwise it is
   `unsupported_image_type` (gif, svg and non-base64 URLs are rejected here).
   Base64 outside the standard alphabet with padding, or decoded magic bytes
   that do not match the declared MIME type, is `invalid_image_data`.
6. More than 4 image parts across all messages is `too_many_images`. A data URL
   over 349,551 characters, or a decoded image over 262,144 bytes, is
   `image_too_large`. Data URL length is checked before decoding.

Every rejection is the existing `bad_request` (HTTP 400) envelope with
`detail` set to `media_request_invalid:<reason>`, and happens before any
upstream call or ledger write. PNG and JPEG are accepted for compatibility
with generic OpenAI-compatible clients, but claude-mem clients send WebP only.
Server model selection, the forced `stream:false`, usage accounting,
price-first provider routing and the stripping of `models`/`fallbacks` stay
exactly as they are.

A 400 is unrecoverable to older workers. A worker that receives
`media_request_invalid:` for an image turn may resend the same turn once,
text-only, with every image `uninspected`. That retry is not a vision call.
Fixture: `validator-cases.json`. Its `synthetic` entries describe oversized
inputs that a test generates.

### Inspection state and manifest updates

A link is `inspected` only when all of these hold:

- The request carried that image's pixels.
- The provider returned an accepted 2xx response.
- The response parsed as valid output.
- The ref survived the linkage rules above.

Everything else is `uninspected`: capture, deferral, text-only fallback,
parse failure, skip, unassigned images, rejected refs and capture-only links.
A capture-only link is never `inspected`.

Writing to `metadata.cmem_media_v1` follows these rules, for inspected and
capture-only links alike. Fixture: `manifest-merge.json`.

- Validate the existing namespace first. An invalid namespace fails closed
  with `invalid_manifest` and is never overwritten.
- Union by attachment `id`. Existing refs keep their order, and new refs are
  appended in the order the observation lists them (capture-only refs: event
  order, then event label order).
- Inspection for an `id` already present is the OR of both sides. It can be
  upgraded and never downgraded.
- Labels may repeat across events.
- Stop at 32 refs. Refs that do not fit stay on their source event (local
  `media_event_refs`, or the equivalent cloud event refs), get no junction
  row, and set `overflow:true`. Once true, overflow stays true.
- Junction rows (local `observation_media_links`, cloud
  `(user_id, canonical_document_id, attachment_id)` links) exist exactly for
  the refs in the manifest.
- Preserve every other metadata key.
- When a native local row's manifest changes, increment its canonical decimal
  `sync_rev`, clear `synced_at` and notify sync, in the same SQLite
  transaction. That transaction also holds the observation rows, the junctions
  and the durable event result, and it commits before the RAM batch is
  confirmed. A re-link that changes nothing changes no revision.
- Merged or reused row IDs that the store returns get the same union.
- On replay, landed refs and committed event results are recovered without
  another model call.
