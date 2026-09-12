# Handoff — what the user wants for the next session

## The big picture

`origin/main` is now at v12.5.0. Branch `thedotmack/merged-layer3-metadata` is 23 commits ahead of an older base; a straight merge produced 31 conflicts across core files (SessionManager, ResponseProcessor, observation store, transcripts, providers, viewer, build artifacts). The merge was aborted.

The user has decided **not** to merge-resolve. The branch will be **redone as clean commits on top of `origin/main`** on a new branch (working name: `thedotmack/layer3-metadata-v2` — name not yet confirmed). The original branch stays as a reference.

## Five features to redo

`redo-plan/` contains one doc per feature. Read all five:

- `01-layer3-transcripts.md` — Layer 3 transcript Chroma collection
- `02-titans-observer.md` — TITANS observer (**see corrections below**; user is editing this doc)
- `03-observation-source-metadata.md` — observation source metadata data model
- `04-viewer-ui-source-metadata.md` — viewer UI for that metadata
- `05-fifo-confirm-processed.md` — FIFO queue fix

The corrected TITANS approach below is the source of truth for that feature.

## TITANS corrections (the user's stated position)

The original TITANS design overcomplicated things. The user wants this instead:

**The observer's role does not change.** It is still an observer of a session. Its framing, identity, and audience in `code.json` stay as they are. Do not rewrite `observer_role`. Do not introduce a "watching the developer AND the assistant" framing.

**Only two things change:**

1. **More types to look for.** The observer's list of valid observation types is expanded to include conversational signals — `correction`, `frustration`, `overconfidence`, etc. (full list in `02-titans-observer.md` section 2).
2. **Bigger eyes.** The observer's per-tool prompt actually receives the assistant's messages from the surrounding turn. Today the transcript watcher captures `lastAssistantMessage` into session state on main, but only `buildSummaryPrompt` consumes it. The observer prompt needs the same wire.

**Method:**

- Create a sibling mode file in `plugin/modes/` (working name: `code-test.json`). It is a copy of `code.json` with the new types added to `observation_types[]` and an **additive** line in `recording_focus` along the lines of "also worth flagging: corrections from the user, moments of frustration, overconfident claims." Additions only — do not rewrite existing role or focus copy.
- Wire the assistant text into the observer prompt as a separate small commit.
- Iterate prompt copy inside the test mode file. Promote to `code.json` default only after signal validates.

**Explicitly do not build:**

- A new HTTP endpoint
- A new `PendingMessage` type or `'conversation'` enum value
- A new migration for this feature
- A new `SessionManager.queueConversation` method
- A new dispatch branch in any provider
- A `OneShotQuery` utility
- A fire-and-forget HTTP call from the transcript processor

## What the user has not yet decided

- Order to apply the 5 features
- Whether to drop `05-fifo-confirm-processed.md` entirely or cherry-pick the 10-LOC `clearProcessingForSession` patch from `origin/pre-queue-engine-rewrite@a0899529`
- Whether to re-introduce the `generatedByModel` parameter (main appears to have intentionally dropped it)
- New branch name

## Carry-forward facts

- Migration numbering: branch used 27/28/29. Main is at 31. Anything new must be ≥32.
- Provider rename in PR #2255: only matters if provider-level code is touched. Under the corrected TITANS design, no provider files are touched.

## Stashed / untracked work (not part of the redo)

`git stash list` will show one entry containing:

- Removal of the 4-hour `MAX_SESSION_WALL_CLOCK_MS` guard from `src/services/worker/http/routes/SessionRoutes.ts`
- Matching change in `plugin/scripts/worker-service.cjs`
- `HUMAN.md` — Apr 19 design recap (separate thread)
- `plugin/skills/pathfinder/` — pathfinder skill folder

These are not part of the redo plan. Decide separately whether to keep, discard, or fold in.

## Where to pick up

1. Read the 5 docs in `redo-plan/`.
2. Confirm with the user that the TITANS corrections above are reflected in their edits to `02-titans-observer.md`.
3. Confirm commit order and new branch name.
4. User has explicitly directed the **TITANS test mode file** as the concrete next step: a sibling mode JSON plus a small change so the observer prompt receives `lastAssistantMessage`.
5. Stop and show the user before iterating further. Do not write more plans without being asked.
