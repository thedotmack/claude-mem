# Phase 1 contracts, public corpus and offline evaluation handoff

Implemented the Phase 1 contract/evaluation subobjective on fresh L main
`039c6160f0ff26e9fab37cae7f50b994ba68f7ff` and P main
`36337f067a3d9954776fc8609d36e438e30262ca`. No paid inference, bucket provisioning,
production database operation, capture enablement, commits, or push occurred.
Converter/packaging and native runtime evidence are separate handoffs; this
report does not mark their outstanding Windows/macOS/Linux gates satisfied.

Changed sources:

- L `src/shared/media-contract.ts`; P `src/lib/media/contract.ts`: byte-identical
  constants, recipes, safe manifest refs, private provenance, explicit failure
  descriptors and stable error codes. IDs/labels/per-image inspection are bounded;
  malformed/extra fields, duplicate IDs, private paths/keys and bytes in safe refs
  fail closed. `overflow:true` means extra refs remain at event level.
- Both `docs/media-contract-v1.md` and
  `tests/fixtures/media-v1/contracts.json`: byte-identical frozen bounds, stable
  platform/transcript identity fallback, privacy division, disabled capture
  matrix, documented APIs and golden acceptance/rejection cases.
- Both `scripts/media/{evaluation,corpus,generate-corpus,evaluate,contract-checks,evaluation-checks}.ts`,
  with import-path differences only where repository layout requires it.
- L `tests/media/{contract,evaluation}.test.ts`; P
  `scripts/test-media-{contract,evaluation}.ts`.
- Both `tests/fixtures/media-v1/corpus/`: eight public cases/nine image artifacts,
  SHA-256/dimensions/recipe/critical-fact/label manifest and attribution README.
- Both `reports/image-aware/phase-1-dry-run.json`: saved reproducible zero-call
  output, explicitly `qualification:"not_qualified"`.

The starting source/image/pixel/dimension/timeout/derivative/inline/ref limits
are preserved. Newly frozen values are canonical maximum 3 MiB, one no-wait
conversion admission slot, 8 KiB manifest/provenance, 64-character opaque
labels, 4096-character private locators, 1 MiB aggregate gateway derivatives,
3 MiB plus 64 KiB upload body and initial 256 MiB owner quota. Canonical
screenshot WebP is lossless, derivative near-lossless quality 90; photo recipe
uses quality 90 for both variants. These are policies requiring later measured
quality qualification, not guarantees of image readability or provider cost.

The corpus contains synthetic small-text screenshot, terminal error, chart,
diagram, generated art, dark UI and two-image status cases. Its real photograph
is NASA Apollo 17 Blue Marble AS17-148-22727, the unmodified 1024x1024 JPEG from
the [NASA SVS source](https://svs.gsfc.nasa.gov/30613/), credited to NASA Johnson
Space Center under [NASA's informational image usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/).
Source SHA-256 is
`13419b34c17722be52b4a71a7f0beb3ecc8673183c8a2cee8572d5cd9bbe3f93`.
No private user image is included. Existing local live-path fixtures supply
candidate native-shape evidence; all capture paths remain disabled. Model
inference/quality, fixture-backed prompt adapters and full event-to-observation
flow remain Phase 4/5/7 gates.

The evaluation seam defaults to dry run and never resolves derivative bytes or
calls a model in that mode. Explicit execution requires a fixed concrete
evaluation model, positive spend/estimate bounds, at most two retries, at most
4096 output tokens and a request deadline no longer than 180 seconds. Calls are
sequential and process-wide admission prevents overlap. Unknown/lost/timeout
charges stop immediately; timeout retains admission until the caller settles.
Known billed parse failures count toward total spend. Conservative estimates
are preflight reservations, not total-charge guarantees; a final in-flight
overrun is recorded and stops further calls. Live callers require a durable
attempt recorder, whose failure stops the run without another model call.
Every execution gets a random UUID run ID by default. Explicit IDs are bounded
opaque unique execution nonces. Reversed valid output is matched by labels,
not observation array position. Exact critical-fact matching is a conservative
mechanical check; later human review must handle paraphrase and fabrication.
The CLI exposes dry run only until Phase 7 supplies the provider/full-flow
adapter. Unit execution uses injected mocks exclusively.

Verification performed:

| Command/check | Actual result |
| --- | --- |
| L `rtk bun test tests/media/contract.test.ts tests/media/evaluation.test.ts` | 2 pass, 0 fail; contract 42 assertions and evaluation 33 cases |
| P `rtk node --import tsx scripts/test-media-contract.ts` | 42 golden/boundary/privacy checks passed |
| P `rtk node --import tsx scripts/test-media-evaluation.ts` | 33 cases passed; 9 actual converter-derived fixtures; 467,937 source bytes / 209,854 derivative bytes |
| L `rtk bun scripts/media/evaluate.ts` | Eight fixture cases, request_count 0, attempts empty, qualification not_qualified |
| P `rtk node --import tsx scripts/media/evaluate.ts` | Same zero-call report |
| L `rtk npm run typecheck` | Passed |
| P `rtk npx tsc --noEmit --pretty false` | TypeScript: no errors found |
| Node buffer comparison of contract/golden/doc/all corpus files | All L/P byte-identical |

Tests cover disabled default, actual converted WebP fixture bytes, positive
preflight caps, real zero usage, missing/unknown usage, thrown/lost response,
malformed output with preserved charge, billed retry/parse failure, explicit
retry exhaustion, final-request spend overrun, wrong/cross-image labels,
reversed valid output, invalid limits/alias/run ID, durable recorder ordering
and failure, per-image bound, timeout/abort, admission retained until settlement,
and distinct default IDs across repeated executions. Successful mocks remain
explicitly unqualified. Source visual inspection confirmed the public
screenshot/art/photo facts; derivative decoding/bounds were tested, but no
model quality score is claimed.

Phase 0 refreshed primary E1–E9 documents before implementation. The public
[OpenRouter catalog](https://openrouter.ai/api/v1/models) at
`2026-10-03T00:06:12.630Z` resolved `~deepseek/deepseek-flash-latest` to
`deepseek/deepseek-v4.1-flash`, canonical slug
`deepseek/deepseek-v4.1-flash-20260910`, with text/image input and text output.
That is capability evidence only. Fresh Pro owner policy retains the automatic
family alias and price-first routing; evaluation pins do not change production.

Credential-presence checks printed no values. Fresh worktrees and inherited
environment had no relevant OpenRouter/database/test-database/Supabase/Vercel
keys. Main P dotenv had Supabase service-role/public URL presence only; no
OpenRouter or database key was copied. Native macOS arm64, Docker Linux and
isolated PostgreSQL are available; real Windows native execution remains a
required gate. Tests here do not use production credentials.
