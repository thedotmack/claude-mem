---
name: childhood
description: Babysit a shipped release after merge, publication, or deployment. Verify published packages, production behavior, installed plugins, and late CI or user reports until the observation window is clean; use babysit for PR readiness before release.
---

# Childhood

Stay with a release after it ships. Verify what users receive and what production serves, then fix verified regressions within the user's authorized scope. A successful merge or publish command is the start of this work.

## Establish the release

- Identify the repository, release version, immutable tag commit, merge commit, production deployment, and affected delivery surfaces. Use the release receipt and actual provider/registry state; do not guess from the current branch or today's latest build.
- Record the release, observation start/end, checks, findings, and next action with `work_state_write` when available. Keep announcements and unrelated infrastructure failures distinguishable from product regressions.
- Carry forward existing authorization. Monitoring does not itself authorize another release, rollback, production migration, or external announcement. Prepare and validate a concrete fix before requesting any authorization still missing.

## Verify the delivered release

Choose the checks relevant to its delivery surfaces; independent checks can run in parallel.

| Surface | Evidence to collect |
| --- | --- |
| Source and CI | Confirm the tag resolves to the shipped commit. Inspect CI for that commit and any release/changelog commits, including late failures. Paginate new issue reports, merged-PR comments, reviews, and review threads since release; verify actionable reports against the shipped code. |
| Published package | Check the exact registry version and the intended distribution tag separately. Verify package hash, entry points, and required files in the downloaded artifact; run a small installed CLI smoke from an isolated directory. Preserve the command's actual exit code when filtering output. |
| Hosted service | Confirm the live production alias serves the intended deployment/commit. Check health and the changed user path through the real authenticated interface, plus relevant error signals. For schema changes, verify the normal migration ledger reports no pending migrations or drift. |
| Installed plugin | Discover the user's actual enabled registration/cache, not just the marketplace copy. Compare changed source/distribution artifacts and open a fresh tool connection. Compare the running worker's version/path to the enabled install; an updated cache can still talk to a stale process. Exercise the affected install/upgrade handoff where authorized. Check hooks or watcher configuration in their real project/runtime scope; label behavior you did not exercise as unverified. |

For a claude-mem search release, exercise guided steps 1, 2, and 3, automatic search, and readable invalid-input guidance through fresh local and hosted MCP connections when those surfaces shipped. Verify selected evidence, short opaque continuations, and concise text without pure JSON or duplicated structured metadata. Keep probes read-only unless writes are part of the explicit test scope. Never print credentials or private result bodies.

Publication can lag behind a successful command. An exact-version 404 or stale distribution tag remains pending until the registry agrees; use bounded retries and investigate the actual publish target/status before republishing. A warning alone is not a regression: verify the final artifact. Likewise, a failed automated publish job may be superseded by a verified authorized manual publish; retain the workflow failure as a separate finding.

## Observe and repair

- Honor the requested observation window. Without one, watch through 30 minutes after the release first becomes publicly available or production becomes ready, whichever affected surface is later. For an older release, do a fresh sweep and inspect the completed late CI and reports covering that interval.
- Poll pending or changing checks every 30–60 seconds; check steady signals every 2–5 minutes. Keep individual waits at most 60 seconds so user steering and progress updates remain responsive. An unavailable API is a coverage gap, not evidence that the release is healthy.
- Verify each finding before changing code. Distinguish a release regression, a pre-existing issue, an operational failure, and a resolved/transient signal; give each its own evidence and next action.
- Make focused fixes, run checks appropriate to the change, and use the repository's normal PR/release/deployment process. Use [babysit](../babysit/SKILL.md) for a repair PR and [version-bump](../version-bump/SKILL.md) when a new claude-mem release is authorized. Published versions and existing tags stay immutable.
- After a repair ships, restart observation for the changed delivery surface and rerun its affected user path. Preserve unrelated worktrees, workers, registrations, user settings, and inference/provider policy.
- A repeated infrastructure failure or deleted notification webhook needs a concrete follow-up. Keep it pending with its cause and owner action; do not repeatedly retry it or announce success to another destination.

## Finish with evidence

Finish when the relevant CI is settled, delivered artifacts and affected user paths pass, no actionable release regression remains, and the observation window is satisfied. Do one final fresh sweep before reporting.

If a required check cannot be completed, report the release as partially verified with that coverage gap and next action. Separate an externally blocked operational follow-up from verified product health; do not silently mark either as resolved.

Return concise purpose-specific text: release/tag/deployment identity, checks and observation times, verified findings and repairs, and anything still pending. Keep raw API envelopes, internal metadata, and complete logs out of model-facing output. Link to a compact receipt when useful.
