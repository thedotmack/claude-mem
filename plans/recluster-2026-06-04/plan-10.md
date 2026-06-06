# [plan-10] Build / Bundle / CI Artifact Hygiene — enforce a boundary on what we ship

## Defect

There is no enforced contract on what the published artifact contains, so the shipped tarball/lockfile can omit required runtime dependencies. The persistent `Cannot find module zod/v3` failure on Linux is the live symptom: `zod` is absent from the installed `node_modules` because the shipped lockfile resolves only a subset of declared dependencies, and the fault recurs on every auto-update. The fix is a CI-enforced boundary: the lockfile and tarball must contain exactly the runtime closure, verified on a clean install before publish.

## Children

- #2730 — v13.4.0: worker/Stop hook fails `Cannot find module zod/v3` — zod absent from installed node_modules (Linux); recurs on every auto-update

## Fix sequence

Design doc: `plans/10-build-artifact-hygiene.md`. Regenerate/verify the lockfile so it carries the full runtime closure; add a clean-room install + import smoke test to CI that fails when any runtime dep (zod, etc.) is missing; gate publish on it.

## Test matrix

| Step | Required behavior |
|---|---|
| clean install from tarball | every runtime dep present |
| import worker / Stop hook | no `Cannot find module` |
| auto-update | dependency closure stable across updates |

## Out of scope

Installer host detection (plan-04).
