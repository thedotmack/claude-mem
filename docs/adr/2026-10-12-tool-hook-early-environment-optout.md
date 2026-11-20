# Honor tool-hook environment opt-outs before loading the runtime

## Context
Issue #4710 observes synchronous file-context startup cost even when its environment opt-out is set: the worker bundle loads before reading the flag. Existing opt-out switches have already defined which tool hooks may be skipped.

## Decision
Check those same `1` environment switches at the beginning of the generated POSIX launcher and the native Codex Windows Node launcher. Update committed hook commands from the existing build manifest. Preserve all lifecycle hooks and independent per-hook flags.

## Alternatives
Changing hooks to async changes File Read Gate behavior. Reading feature settings in a shell duplicates settings resolution and adds I/O. A new opt-out setting is unnecessary because these explicit environment switches already exist.

## Consequences
Disabled POSIX tool hooks start no Node or Bun process. The native Windows entry still needs Node but skips plugin resolution and the Bun/worker spawn. Hosts still start their registered hook. This addresses explicit environment opt-outs, not the broader request to make feature flags alter synchronous registration. No installed user plugin is changed by development checks.

## Validation
Bun1.4.3 synthetic launcher regression: upstream2pass6fail; candidate8pass0fail. Tests execute generated shell and Windows Node commands on macOS using isolated scripts that record a runtime launch. Enabled controls and SessionStart still launch. Native Windows host execution and live Claude latency were not measured. Local logs preserve exact test evidence. Existing distribution suite had100pass and an npm-pack timeout under its5-second ceiling. The unchanged package check passed with the30-second test timeout (20.6seconds); canonical template checks30pass. Local build-hooks completed alltargets and verified canonical templates. Final combined launcher/distribution suite101pass0fail616assertions with the30-second per-test timeout. Generated bundles were kept out of the implementation revision. No provider API, paid inference or production worker used.
