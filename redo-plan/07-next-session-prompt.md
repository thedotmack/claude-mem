# Next-session prompt — execute PR 1 (TITANS expanded mode)

> Paste the body below into a fresh Claude Code session in this worktree. It is self-contained.

---

You are picking up a multi-session redo on `claude-mem`. Read this prompt fully before doing anything.

## Situation

- Worktree: `/Users/alexnewman/conductor/workspaces/claude-mem/vancouver`.
- Branch right now: `thedotmack/merged-layer3-metadata` (the old, abandoned branch — 23 commits ahead of `origin/main` from a botched merge).
- `redo-plan/` is untracked on this branch and contains the planning docs you need to read.
- `origin/main` is at v12.6.0 (commit `43037782` at the time of writing). Use whatever is the latest `origin/main` at execution time.

## What we're doing

Re-applying 5 features from the abandoned branch as **clean per-PR commits on fresh branches off `origin/main`**. One feature per PR. No mega-branch. Today's job is **PR 1: TITANS expanded mode (minimal)**. The user wants to ship it today.

## Read these in order (they exist; do not re-write them)

1. `redo-plan/00-handoff.md` — the user's directives. Pay attention to the **"TITANS corrections"** section.
2. `redo-plan/06-execution-plan.md` — the orchestration plan. PR 1 is "Phase 1" in that doc.
3. `redo-plan/02-titans-observer.md` — feature analysis. Read §1–§6 for background.

## What PR 1 actually is

Two changes, that's it:

1. **`plugin/modes/code-test.json`** — a sibling mode file. Copy of `plugin/modes/code.json`, with **only additive** changes:
   - Append the missing types to `observation_types[]`: `correction`, `frustration`, `overconfidence`, `commitment`, `pattern_recognition`, `emotional_signal`, `insight` (intersect with what `code.json` already has — only add the missing ones).
   - Append **one** line to `recording_focus` along the lines of: `"Also worth flagging: corrections from the user, moments of frustration, overconfident claims."` Wording can iterate; structure must be additive. Do **not** rewrite `observer_role` or any existing field.

2. **Wire ALL assistant messages from the current turn into the observer prompt.** Main's transcript watcher captures only `lastAssistantMessage` (singular). That's not enough — between user turns, the assistant streams multiple messages (text → tool call → more text → tool call → more text), and the observer needs to see all of them in order to flag overconfidence/correction signals from anywhere in the turn, not just the most recent line.

   **Implementation shape:**
   - Add an accumulator field to session state — e.g. `assistantTurnMessages: string[]` (name TBD; match the existing convention of `lastAssistantMessage` neighbors).
   - On every `assistant_message` event in the transcript watcher, append to the accumulator (in addition to whatever sets `lastAssistantMessage` today — keep that wire intact for `buildSummaryPrompt`, which is the existing consumer).
   - On every `user_message` event, reset the accumulator to `[]`. The observer should only see assistant text from the *current* turn.
   - In the observer prompt builder (the per-tool-use one), read the accumulator and render it as a "transcript so far" block in chronological order.
   - **Reuse** `buildSummaryPrompt`'s read pattern as a reference for *how* to access session state, but **don't** reuse `lastAssistantMessage` as the data source — it's the wrong shape (singular vs. list).

   **What this is *not*:**
   - Not a new event type on the watcher. The `assistant_message` and `user_message` events already exist on main.
   - Not a new pipeline. Same per-tool-use observer trigger, same prompt mechanism, same result handling.
   - Not the branch's `ConversationExchange[]` accumulator. That was wired for a *different* feature (the dropped conversation-observation pipeline). This accumulator is just feeding the existing observer's prompt with more context.

## Hard "do not build" list (from handoff §"TITANS corrections")

The user has explicitly forbidden all of these. Do not introduce any of them:

- ✗ A new HTTP endpoint (no `/api/sessions/conversation-observe`)
- ✗ A new `PendingMessage` type or `'conversation'` enum value
- ✗ A new migration for this feature
- ✗ A new `SessionManager.queueConversation` method
- ✗ A new dispatch branch in any provider (`ClaudeProvider` / `GeminiProvider` / `OpenRouterProvider`)
- ✗ A `OneShotQuery` utility
- ✗ A fire-and-forget HTTP call from the transcript processor
- ✗ Rewriting `observer_role` in any mode file
- ✗ "Watching the developer AND the assistant" framing — the observer's identity stays as is
- ✗ Promoting `code-test.json` content into `code.json` in this PR (promotion happens later, after signal validates)

## Execution steps

1. **Confirm the branch name with the user before creating it.** Proposed: `thedotmack/titans-expanded-mode`.

2. **Branch setup:**
   ```bash
   git fetch origin
   git switch -c thedotmack/titans-expanded-mode origin/main
   ```
   The `redo-plan/` directory is untracked on the old branch and will follow you to the new branch. Good — that's the first commit.

3. **Commit 1 — docs:** add the 6 redo-plan markdown files.
   ```bash
   git add redo-plan/
   git commit -m "docs: add redo-plan handoff package"
   ```

4. **Verify Phase 0 from `06-execution-plan.md`:**
   - Confirm `origin/main` HEAD is what you branched from.
   - Spot-check the v12.5.0 → v12.6.0 delta against `02-titans-observer.md` §8 conflict table for the TITANS-relevant files: `src/services/transcripts/processor.ts`, `src/services/transcripts/watcher.ts`, `src/sdk/prompts.ts`, `plugin/modes/code.json`. If anything material changed, surface it before continuing.
   - Read `plugin/modes/code.json` so you know exactly what's in it now.

5. **Commit 2 — `code-test.json`:**
   - Read `plugin/modes/code.json`, then write `plugin/modes/code-test.json` as a strict superset (additive only).
   - Validate JSON parses: `node -e "JSON.parse(require('fs').readFileSync('plugin/modes/code-test.json','utf8'))"`
   - Diff against `code.json` and confirm only additions.
   - **Verify the mode loader can pick up `code-test`**: grep for where `code.json` is referenced (`grep -rn "code\.json" src/ plugin/`). If it's hard-coded, the loader needs a tiny tweak to take the mode name from settings/env. Make that tweak in this commit only if it's <5 lines; otherwise split into commit 2a.
   - Commit:
     ```
     feat(modes): add code-test mode with expanded TITANS observation types
     ```

6. **Commit 3 — accumulate all assistant turn messages into the observer prompt:**
   - Locate the watcher write site for `lastAssistantMessage` (search `src/services/transcripts/` for `lastAssistantMessage`). Note its event hook — that's where you'll *also* append to the new accumulator.
   - Locate the `user_message` handler in the same watcher — that's where you'll reset the accumulator.
   - Locate `buildSummaryPrompt` (search `src/sdk/prompts.ts` and surrounding files) and note the access pattern for reading session state.
   - Locate the observer-prompt build site for tool-use observations and the path that calls it.
   - **Add a new field on session state** (e.g. `assistantTurnMessages: string[]`) — singular `lastAssistantMessage` is the wrong shape; we need every assistant message in the current turn, not just the most recent.
   - Wire the watcher to append on `assistant_message` and clear on `user_message`. Keep the existing `lastAssistantMessage` write intact (`buildSummaryPrompt` still consumes it).
   - In the observer prompt builder, read the accumulator and render the messages as a "transcript so far" block in chronological order.
   - **No new event types on the watcher. No new pipeline. No new endpoint. No HTTP call.** Just an accumulator on session state and a read in the prompt builder.
   - Commit:
     ```
     feat(observer): include full assistant turn transcript in observer prompt
     ```

7. **Build:**
   ```bash
   npm run build
   ```

8. **Smoke-test in the docker dev container** (per `CLAUDE.md` "Persistent detached dev container" snippet):
   - Bring it up if not running.
   - After this build, restart the in-container worker.
   - Drive a session that uses `code-test` mode (set whatever env/setting selects the mode).
   - Inspect `~/.claude-mem/logs/worker.log` (or container stdout) for the rendered observer prompt — confirm it includes the new types **and** a "transcript so far" block with assistant messages.
   - **Multi-message accumulator check:** drive an assistant turn that emits multiple text messages before a tool call (e.g., "I'll do X" → "let me first check Y" → tool call). Confirm the observer prompt for that tool call contains *all* the assistant messages from the turn, not only the most recent one.
   - **Reset check:** after a user message arrives, the next observer prompt should not contain assistant text from the prior turn.
   - Trigger a conversational signal (e.g., correct the assistant on something) and confirm a TITANS-typed observation row appears in the database. SQLite at `.docker-claude-mem-data/claude-mem.db`:
     ```bash
     sqlite3 .docker-claude-mem-data/claude-mem.db \
       "SELECT id, type, title FROM observations ORDER BY id DESC LIMIT 10;"
     ```
   - **If the UI doesn't reflect the change, say so explicitly. Don't claim success on type-check pass alone.**

9. **Open the PR:**
   - Push: `git push -u origin thedotmack/titans-expanded-mode`
   - `gh pr create --base main --title "feat: TITANS expanded mode (minimal)" --body "<see template below>"`
   - Body template:
     ```
     ## Summary
     - Adds `plugin/modes/code-test.json` — sibling to `code.json` with the TITANS observation types appended (additive only; no rewrite of observer_role or recording_focus).
     - Adds an `assistantTurnMessages` accumulator on session state (appended on every `assistant_message` watcher event, reset on `user_message`) and renders it as a "transcript so far" block in the observer prompt builder. Existing `lastAssistantMessage` wire to `buildSummaryPrompt` is unchanged.

     ## What this is NOT
     - Not a new pipeline, endpoint, queue type, migration, or provider dispatch branch.
     - Not a rewrite of the observer's role or framing.
     - Promotion of test-mode content into `code.json` is deferred until signal validates.

     ## Test plan
     - [ ] `npm run build` clean.
     - [ ] `code-test.json` parses; diff against `code.json` is additive only.
     - [ ] Observer prompt rendered in a real session contains the new types and an "assistant just said" block.
     - [ ] A user correction in conversation produces a TITANS-typed observation row.
     ```

## Stop-and-ask gates

- Before creating the branch, confirm the name with the user.
- Before commit 2, confirm what's currently in `code.json` (paste the relevant fields back).
- Before commit 3, confirm the access pattern in `buildSummaryPrompt` and the observer-prompt build site you've identified.
- Before pushing/opening the PR, show the user the diff summary.

## Critical context that is easy to get wrong

- **Per-PR, not mega-branch.** Each of the 5 features ships as its own PR off main. PR 1 is just TITANS minimal. Do not bundle in metadata, layer 3, viewer UI, or queue work.
- **The "queue collapse" (PR #2255) is the user's intentional design.** The user explicitly rejected `clearProcessingForSession` as "against our design" on the Greptile thread. Do **not** re-introduce per-message tracking under any name, in any PR — including this one. Burst-window message loss in `clearPendingForSession` is an accepted trade-off.
- **`generatedByModel`** parameter is **not** being re-introduced (D4 in execution plan). Don't add it.
- **Stash@{0}** on the old branch (wall-clock guard removal, HUMAN.md, pathfinder skill) is **out of scope** for this redo. Don't fold it in.

## When you're done with PR 1

- Confirm the PR is open and CI is green (or note what's failing).
- Stop. The user will decide PR 2 timing separately. Do not proactively start PR 2.
- Update `redo-plan/06-execution-plan.md` Phase 1 verification checklist with what actually shipped, and add a one-line note at the top of the file: `> P1 shipped as #<PR-number> on <date>.`
