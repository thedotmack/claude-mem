# Phase 1 anti-pattern and independent converter/packaging review

Reviewed Phase 1 source additions and packaging changes on October 2, 2026.
Anti-pattern scans pass locally: no prohibited runtime byte/locator leakage,
hidden paid calls, invented API methods, or unsafe metadata retention was found.
Independent code-quality review of the other implementer's converter,
dependencies, installed/native smoke scripts and Pro instrumentation found no
remaining source blocker. This reviewer implemented contracts/evaluation, so
their independent quality review is owned by the separate converter agent.
The required native platform matrix, especially the actual shipped Windows
executable, remains a Phase 1 verification exit gate; source review and
cross-compilation do not satisfy it.

The scan covered L `src/shared/media-contract.ts`, `src/services/media/`,
`scripts/media/`, `tests/media/`, build/clean-room/binary smoke scripts, settings
and `.github/workflows/media-runtime.yml`; P `src/lib/media/`, instrumentation,
evaluation/converter/production smoke scripts and its media-runtime workflow.
Golden fixture negatives and corpus sources were inspected as well.

Commands/evidence:

- `rtk rg -n 'data:image|base64|input_references|getPublicUrl|attachment_ids|pro_observations|keepMetadata|withMetadata|usage.*include|stream_options|fetch\(|axios|OPENROUTER_API_KEY|DATABASE_URL|SUPABASE_SERVICE_ROLE' ...`
  on the changed L/P media boundaries. Every match was classified below.
- `rtk rg -n '\.(keepMetadata|withMetadata|keepExif|withExif|keepIccProfile|withIccProfile|keepXmp|withXmp|keepGainMap|withGainMap)\(' src/services/media src/shared/media-contract.ts scripts/media/evaluation.ts`
  returned no runtime metadata-retention call (exit 1/no matches).
- `rtk rg -n 'fetch\(|axios|input_references|getPublicUrl|usage\s*:\s*\{|include_usage|attachment_ids|pro_observations|supportsImage' src/lib/media src/instrumentation.ts scripts/media scripts/smoke-media-production.cjs`
  returned no forbidden/provider call (exit 1/no matches).
- Read full converters, test fixtures, runtime smoke modules, direct package
  sources, build scripts, fresh-install smoke checks, production NFT smoke,
  runtime flags/instrumentation, and both new workflows. Rechecked primary
  [Sharp APIs/install](https://sharp.pixelplumbing.com/install/),
  [Bun external bundling](https://bun.sh/docs/bundler),
  [Next instrumentation](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation),
  and [GitHub runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
- Reopened the narrow review after the compiled worker's decoder invocation
  exited without a result. `rtk proxy bun build --help` confirmed the exact
  installed `--compile-autoload-package-json` flag and its default false;
  [Bun's primary executable docs](https://bun.com/docs/bundler/executables#automatic-config-loading)
  independently specify the CLI flag and `compile.autoloadPackageJson` option.
  Reviewed the corrected binary builder, early CLI boundary and negative
  installed/native smoke assertions without adding a decoder workaround.

Legitimate matches:

| Match | Why it is allowed |
| --- | --- |
| `base64` in source-shape enum names | An enum descriptor contains no bytes |
| Synthetic 1x1 PNG in L media smoke and P runtime warm-up | Fixed public decoder probe at conversion boundary; no user image/caption/path is logged |
| `data:image`, private paths/keys and byte bodies in golden negatives | Adversarial fixtures prove rejection; they are not accepted or copied into safe manifests |
| `withMetadata`/`withExif` in converter tests | Builds a synthetic EXIF/GPS/orientation input to prove removal; no runtime retention call exists |
| SVG source in public fixture generator | Local authoring of committed PNG artifacts only; converter itself rejects SVG |
| NASA asset/source links and SHA-256 | Attributed public photograph fixture; no private user image or production data |
| Documentation mentions of forbidden wire shapes/opt-ins | Guards only; no actual generation wire field, public URL helper, or deprecated usage opt-in was introduced |

Independent converter review:

- L converter lines 26–40 verifies PNG/JPEG/WebP magic and APNG control chunks;
  other formats/animation fail. Source bytes are never returned as a media
  variant. Source size, dimensions and decoded-pixel limits are explicit.
- Lines 69–84 admit one no-wait conversion. The application deadline covers
  load/metadata/both encodes; lines 160–165 hold admission until underlying work
  settles after caller timeout. Documented Sharp timeout alone is not used as
  the wall-clock guarantee.
- Lines 99–140 use strict documented constructors, auto-orientation, full-frame
  inside/no-enlargement resizing, fixed versioned WebP recipes and bounded
  canonical/derivative results. No unlimited decode, adaptive encoding loop,
  crop/classifier, or metadata-preserving call appears.
- Decoder failures become safe `MediaError` codes (lines 153–158), not backend
  exception text. P runtime logs only status, encoder, sizes and safe code.

Independent distribution/startup review:

- Sharp `0.35.5` is a direct runtime dependency in both repos. Local generated
  plugin dependency source and worker externals live in `scripts/build-hooks.js`
  (lines 324/396), not only in a hand-edited generated manifest. No new native
  postinstall allowlist exemption was silently added.
- Clean-room testing resolves Sharp from the installed plugin/npm package,
  disables that installed decoder, checks flags-off startup, restores it, and
  invokes the shipped worker's real `media-smoke`. Children use empty
  `NODE_PATH` and an isolated data directory.
- The previous unknown `--version` path could enter daemon startup and time
  out. Source now has a deliberate `--version` print-and-return handler in
  `src/services/worker-service.ts` (around line 1277). The clean-room baseline
  timeout is now failure, rather than evidence of a healthy text startup.
  Final rebuilt Linux/fresh-install evidence must use normal exit; the earlier
  manual timeout result is superseded and cannot count as success. Both
  installed-worker probes and the native binary probe assert exact package
  version stdout, exit status zero and no spawn error, including timeout.
  The implementer's [final handoff](phase-1.md) records
  `rtk npm run smoke:clean-room` passing in the final corrected 20.3-second
  run: frozen plugin and
  npm-tarball installs each printed `13.28.0` and exited normally with Sharp
  removed, failed `media-smoke` with exact bounded `decoder_unavailable` JSON
  and exit one, then decoded both real 1x1/36-byte WebP variants after
  restoration.
  This is reported artifact execution evidence, separate from this reviewer's
  source inspection and the pending independent platform matrix.
  Branch/Sync's final independent checks also passed both frozen plugin and
  fresh npm-tarball installations on Linux arm64 and x64: exact `13.28.0`
  stdout, normal exit zero with Sharp removed, then viewer/LLM 1x1/36-byte
  WebPs with Sharp 0.35.5/libvips 8.18.7 restored. See the Pro execution
  worktree's `reports/image-aware/phase-1-verification.md` for its commands and
  artifact hashes. This reviewer did not execute those platform probes.
- Windows packaging compiles the existing shipped CJS worker graph instead of
  the failing independent TS/Zod graph, marks Sharp external, and writes a
  locked target-native sidecar manifest. `smoke-media-binary.cjs` installs the
  sidecar in a fresh directory and executes from another cwd with no checkout
  resolution. `build:binaries` invokes only `build-worker-binary.js`; that
  script first invokes the ordinary `build`, which does not call the binary
  script. There is no script recursion, and direct invocation also rebuilds
  recent source. The compile-time `__CMEM_MEDIA_STANDALONE__` flag forces main
  only for the compiled CJS entry; ordinary source/library imports retain the
  existing entry guard. These source changes require native Windows execution
  proof. The corrected PE hash is
  `ac0502faf95e5a405b01e64681bbca12633533cce3ebf0da3dde5e723cc091e4`.
  Earlier Wine returning zero without decoder-result JSON was inconclusive;
  the same symptom reproduced natively on macOS and exposed a compiled loader
  defect. That earlier executable/hash and evidence are superseded by the
  correction below, not accepted as a Windows decode pass.
- The final compiled loader correction is the documented
  `--compile-autoload-package-json` build flag. Bun disables runtime package
  metadata loading by default; enabling it restored anchored Sharp and nested
  native dependency resolution in the real compiled probe. Converter loading
  remains `createRequire` anchored beside the executable and returns Sharp's
  direct CommonJS function export. A shape-only installed Node probe confirmed
  require returns a function, with no `.default`, for Sharp 0.35.5.
- `media-smoke` now returns before settings/port initialization. Its safe catch
  covers the lazy module import and conversion, emits only
  `{mediaRuntime:'failed',code}` to stderr, and sets exit status one. The first
  proposed catch left module import outside its boundary; this review found
  that gap and the implementer corrected it. Missing-sidecar installed/native
  smoke probes require exact failure JSON and nonzero status, so the legacy
  generic CLI catch cannot turn a missing decoder into a passing probe.
- The implementer's final native macOS arm64 compiled shipped-CJS probe used
  a freshly installed locked sidecar adjacent to the executable, an unrelated
  cwd and empty `NODE_PATH`. With Sharp removed, version printed `13.28.0`
  and exited zero; media smoke emitted exactly
  `{"mediaRuntime":"failed","code":"decoder_unavailable"}` and exited one.
  Restored Sharp produced actual success JSON, exit zero and both 1x1/36-byte
  viewer/LLM WebPs with Sharp 0.35.5/libvips 8.18.7. The reproduced compiled
  loader defect is corrected on this tested native platform. This reviewer
  approved source/docs independently and cites implementer artifact evidence;
  native Windows and macOS Intel execution are still required.
- Pro's Node-only instrumentation lazy-loads conversion only for opted-in
  capture. The NFT smoke copies traced production assets into a fresh tree,
  invokes the built instrumentation, then removes every copied Sharp entry
  root. Flags-off startup and enabled-but-missing decoder failure are distinct
  probes. Readiness gates capture and both feature switches default off.
- New workflows declare macOS arm64/Intel, Linux x64/arm64, Windows 2022 and
  Pro Linux production checks using currently documented runner labels. They
  contain no paid/production credentials, provider requests, public enablement
  or bucket provisioning. Configured workflows are not successful CI runs.

Result: anti-pattern scan and independent converter/packaging source quality
approved locally, including the final package-loading flag, startup guard,
safe media failure boundary and strict positive/negative probes. Native
compiled macOS arm64 packaging has passing artifact evidence.
Actual native Windows executable and macOS Intel execution remain pending;
Phase 1 is not fully verified and Phases 2–8 must not be advanced under the phased protocol
until that exit gate is satisfied. No commit/push/release approval is implied.
