# Onboarding UX Overhaul

Three surfaces, one product voice, one first-success moment. Each phase is self-contained and can be executed in a fresh chat with `/do`.

## North Star

Pull the user toward this single moment: **open the viewer in a browser, do anything in Claude Code, watch an observation appear within seconds.** All three surfaces aim at it from different angles.

## Cross-Cutting Facts (read this first, every phase)

- **Test runner:** `bun test`. Test command: `npm run test`. Tests live in `tests/`. Pattern templates: `tests/sqlite/observations.test.ts:1-60` (in-memory SQLite + bun:test), `tests/install-non-tty.test.ts:1-95` (regex assertions over install.ts source).
- **Build:** `npm run build-and-sync` runs full build (banner frames + plugin manifests + `scripts/build-hooks.js`) → marketplace sync → worker restart. Viewer compiles via esbuild to `plugin/ui/viewer-bundle.js`; HTML template (which holds ALL CSS) at `src/ui/viewer-template.html`.
- **Settings defaults:** `src/shared/SettingsDefaultsManager.ts:70-131`. Merge logic at `loadFromFile()` lines 161-205 — missing keys auto-pick up new defaults, explicit values are respected. Forward-compatible.
- **`CLAUDE_MEM_WELCOME_HINT_ENABLED` already defaults to `'true'`** (`SettingsDefaultsManager.ts:104`). Single reader at `SearchRoutes.ts:294`. Goal 5 from the brief is already done — we replace "flip the default" with "pin it with a regression test."
- **Timing line, identical wording everywhere:** `Memory injection starts on your second session in a project.`
- **Privacy line, identical wording everywhere:** `Everything stays in ~/.claude-mem on this machine.`

---

## Phase 0 — Documentation Discovery (DONE; for reference)

Discovery already completed. Allowed APIs and signatures established:

### Install.ts patterns (`src/npx-cli/commands/install.ts`)
- `log` helper at lines 41-46 — methods `info | success | warn | error`, conditionally routes to `p.log.*` (interactive) vs `console.log/warn/error` (non-interactive, 2-space indent).
- `p` is `* as p from '@clack/prompts'`. Used: `p.note(body, title)`, `p.outro(msg)`, `p.intro`, `p.log.*`, `p.tasks`, `p.spinner`, `p.select/multiselect/confirm/password`, `p.isCancel`, `p.cancel`.
- `pc` is `picocolors` default import. Available: `pc.cyan/green/yellow/red/bold/underline/dim/bgCyan/black`. **`pc.dim` exists** (already in use at line 663).
- `getSetting('CLAUDE_MEM_WORKER_PORT')` returns string; convert with `Number()` when needed.
- Health probe pattern at lines 843-864: `fetch('http://127.0.0.1:${port}/api/health', { signal: AbortSignal.timeout(3000) })`, non-throwing.
- Existing `summaryLines` block (826-841) and `nextSteps` block (866-896) — both have parallel interactive (`p.note`) and non-interactive (`console.log`) branches.

### Settings (`src/shared/SettingsDefaultsManager.ts`)
- `CLAUDE_MEM_WELCOME_HINT_ENABLED: 'true'` at line 104.
- Merge: defaults first, then file overrides, then env overrides (lines 194-201).
- Install does NOT pre-seed this key — only seeds prompted settings (provider, model). Existing users without explicit value automatically get the new default.
- `SettingsRoutes.ts:84-117` — flag is NOT in the user-updatable allowlist (read-only via UI).
- Test template: `tests/install-non-tty.test.ts` (regex over source); SettingsDefaultsManager has no dedicated test file — would be created if needed.

### SessionStart hint (`src/services/worker/http/routes/SearchRoutes.ts`)
- `WELCOME_HINT_TEMPLATE` at lines 14-27. Used at line 301: `WELCOME_HINT_TEMPLATE.replace('{viewer_url}', viewerUrl)`.
- Gating logic at lines 293-306. Only fires when `hintEnabled && !full && observationCount === 0`.
- Output is plain text injected as SessionStart `additionalContext` via the SessionStart hook (`src/cli/handlers/context.ts`).

### Viewer (`src/ui/viewer/`)
- `useSSE()` at `src/ui/viewer/hooks/useSSE.ts:1-148` exposes `{ observations, summaries, prompts, projects, sources, projectsBySource, isProcessing, queueDepth, isConnected }`. Auto-reconnects; new observations prepended via `'new_observation'` SSE event.
- `WelcomeCard` mounted in `src/ui/viewer/App.tsx:128-130`, currently receives only `onDismiss`. App has access to all SSE state (lines 51-67).
- All viewer CSS lives in `src/ui/viewer-template.html`; existing `.welcome-card*` styles at lines 1443-1561; existing `.status-dot` + `@keyframes pulse` at lines 754-764.
- Stats endpoints: `/api/stats` (`DataRoutes.ts:204-242`) returns `{database: {observations, sessions, summaries}, worker: {...}}`. `/api/projects` (`DataRoutes.ts:244-260`) returns `ProjectCatalog`. **No `firstObservationAt` field currently — Phase 4 adds it.**
- `/api/how-it-works` is NOT a static explainer — it queries observations tagged with the `'how-it-works'` concept (`SearchManager.ts:836-884`). Useless on a fresh install. Phase 1 adds a true static explainer.

### Skills (`plugin/skills/`)
- 9 existing skills, each a directory with `SKILL.md` and YAML frontmatter (`name`, `description`). No central registry — discovered by directory convention.
- Template to copy: `plugin/skills/mem-search/SKILL.md`.

### Anti-patterns to avoid
- DO NOT call `/api/how-it-works` for an onboarding explainer — wrong endpoint.
- DO NOT add new viewer CSS files — all styles in `src/ui/viewer-template.html`.
- DO NOT add new viewer routes for stats unless strictly needed — extend `/api/stats` instead.
- DO NOT seed `CLAUDE_MEM_WELCOME_HINT_ENABLED` in `install.ts` — defaults already handle it.
- DO NOT pass imperatives ("you should run X") in the SessionStart hint — Claude will try to execute. Use third-person narration ("`/learn-codebase` is available if…").

---

## Phase 1 — Canonical Onboarding Explainer

**Why:** All three surfaces need a single source of truth for the 90-second "what is this" explainer. `/api/how-it-works` does not serve this purpose. We'll create a real static explainer and link to it from everywhere.

### Tasks

1. Create `src/services/worker/onboarding-explainer.md` — single canonical content. ~150 words, three sections:
   - **What it does:** Every Read/Edit/Bash Claude makes turns into a compressed observation. Observations get summarized at session end. Relevant ones get auto-injected into future prompts.
   - **When it kicks in:** Memory injection starts on your second session in a project. *(verbatim timing line)*
   - **Where data lives:** Everything stays in ~/.claude-mem on this machine. *(verbatim privacy line)*

2. Add new route `GET /api/onboarding/explainer` in `src/services/worker/http/routes/SearchRoutes.ts`:
   - Read the markdown file at boot (cache like `cachedSkillMd` pattern in `Server.ts:18-33`).
   - Serve as `text/markdown; charset=utf-8`.
   - Register in `setupRoutes()` next to the other `/api/context/*` routes.

3. Create `plugin/skills/how-it-works/SKILL.md`:
   - Copy frontmatter shape from `plugin/skills/mem-search/SKILL.md:1-4`.
   - `name: how-it-works`
   - `description: Explain how claude-mem captures observations, when memory injection kicks in, and where data lives. Use when the user asks "how does claude-mem work?" or "what is this thing doing?".`
   - Body: same content as the markdown explainer (or fetch `/api/onboarding/explainer` at runtime).
   - Wire into `scripts/build-hooks.js` verification list (lines 336-348) so build fails if the file is missing.

### Verification

- `npm run build-and-sync` succeeds; new SKILL.md present in `plugin/skills/how-it-works/`.
- `curl http://localhost:$PORT/api/onboarding/explainer` returns the markdown.
- Worker boot log includes a "Cached onboarding explainer at boot" entry (mirroring the SKILL.md cache log).

### Anti-pattern guards

- Do NOT alter `/api/how-it-works`. It serves a different (concept-tagged search) purpose.
- Do NOT inline the explainer text into install.ts / WelcomeCard / WELCOME_HINT_TEMPLATE — link, don't duplicate.

---

## Phase 2 — SessionStart Welcome Hint Rewrite

**Why:** Current copy reads as a marketing intercept inside Claude's context, leads with imperatives Claude tries to execute, and doesn't set the truthful "today seeds, tomorrow injects" expectation.

### Tasks

1. Rewrite `WELCOME_HINT_TEMPLATE` at `src/services/worker/http/routes/SearchRoutes.ts:14-27`. Target:

   ```
   # claude-mem status

   This project has no memory yet. The current session will seed it; subsequent sessions will receive auto-injected context for relevant past work.

   Memory injection starts on your second session in a project.

   `/learn-codebase` is available if the user wants to front-load the entire repo into memory in a single pass (~5 minutes on a typical repo, optional). Otherwise memory builds passively as work happens.

   Live activity: {viewer_url}
   How it works: `/how-it-works`

   This message disappears once the first observation lands.
   ```

   Constraints: third-person narration referring to "the user", not imperatives directed at Claude. Title is "status", not "Welcome".

2. **Pin the default with a test.** In a new file `tests/shared/welcome-hint-default.test.ts`:
   - Assert `SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_WELCOME_HINT_ENABLED === 'true'`.
   - Assert that an empty settings file resolves to `'true'`.
   - Assert that an explicit `'false'` is preserved through `loadFromFile`.

3. No install.ts seeding change — defaults already flow through.

4. Audit existing welcome-hint tests (memory note: "4/4 tests pass"). Likely in `tests/worker/SearchManager.timeline-anchor.test.ts` per discovery; if those tests assert the old template body verbatim, update them to match the new copy. If they only assert the gating logic, leave alone.

### Verification

- `bun test tests/shared/welcome-hint-default.test.ts` passes.
- `bun test tests/worker/` (or whichever file holds the welcome-hint tests) passes.
- Manual: in a fresh project with zero observations, start a Claude Code session — SessionStart context includes the new status note. New text contains the verbatim timing line and points at `{viewer_url}` and `/how-it-works`.
- Manual: in a project with observations, the hint does NOT appear (gating still works).

### Anti-pattern guards

- Do NOT use the word "Welcome" or any second-person imperatives ("you should…", "go to…"). Claude will try to "help" by executing them.
- Do NOT exceed ~10 lines — this is injected into Claude's context for every fresh-project session.

---

## Phase 3 — Post-Install Next Steps Rewrite

**Why:** Current 4-bullet menu treats `/learn-codebase`, `/mem-search`, and `/knowledge-agent` as parallel options. They aren't — `/learn-codebase` is the only first-session move and even it's optional. Lead with proof (live viewer), give two paths, defuse the privacy concern.

### Tasks

1. Replace the `nextSteps` array at `src/npx-cli/commands/install.ts:866-878`. Target body when worker is ready:

   ```
   ${pc.green('✓')} Worker running at ${pc.underline(`http://localhost:${actualPort}`)}

   ${pc.bold('First success:')} keep that URL open in a browser, then open Claude Code in any project. Observations stream in as Claude reads, edits, and runs commands.

   ${pc.bold('Two paths from here:')}
     ${pc.cyan('A.')} Just start working. Memory builds passively from your first prompt. (Recommended.)
     ${pc.cyan('B.')} Front-load it: open Claude Code and run ${pc.bold('/learn-codebase')} to ingest the whole repo (~5 min, optional).

   Memory injection starts on your second session in a project.
   Everything stays in ${pc.cyan('~/.claude-mem')} on this machine.

   ${pc.dim('How it works: /how-it-works   ·   Disable first-session hint: CLAUDE_MEM_WELCOME_HINT_ENABLED=false')}
   ${pc.dim('Note: close all Claude Code sessions before uninstalling, or ~/.claude-mem will be recreated by active hooks.')}
   ```

   Worker-not-ready branch: keep the existing `pc.yellow('!')` warning + retry hint, then append the same "First success" / "Two paths" / timing / privacy lines (substituting `workerPort` for `actualPort`).

2. Drop `/mem-search` and `/knowledge-agent` lines from this surface entirely. (They reappear in WelcomeCard for users who do open the viewer.)

3. Keep both `isInteractive` (uses `p.note(nextSteps.join('\n'), 'Next Steps')`) and non-interactive (`console.log` per line, 2-space indent) branches in sync. The array shape stays the same — only the strings change.

4. Verify `pc.dim` renders correctly under the clack `p.note` box (it does — line 663 already uses it).

### Verification

- `npm run build` succeeds.
- Manual interactive run: `npx claude-mem install` in a fresh dir shows the new Next Steps block inside the clack box.
- Manual non-interactive run: `CI=true npx claude-mem install` (or pipe through cat) shows the same content with 2-space indent and no clack boxes.
- Update `tests/install-non-tty.test.ts` regex assertions to match the new strings (existing pattern: `expect(installSource).toContain(...)`).

### Anti-pattern guards

- Do NOT add new commands to this surface. The point is reduction.
- Do NOT lose the uninstall caveat — demote, don't delete.
- Do NOT reorder so the worker URL becomes a footnote — it's the single most important payload here.

---

## Phase 4 — Extend `/api/stats` with `firstObservationAt`

**Why:** The viewer micro-stat row (Phase 5) needs a "since [date]" value. No HTTP endpoint currently exposes the earliest observation timestamp. Smallest possible backend change to enable Phase 5.

### Tasks

1. Add a `firstObservationAt: string | null` field to the stats response in `src/services/worker/http/routes/DataRoutes.ts:204-242` (`handleGetStats`).

2. Add a SQL helper next to `getRecentObservations` (`src/services/sqlite/observations/recent.ts:6-20`):

   ```ts
   export function getFirstObservationCreatedAt(db: SessionStore): string | null {
     // SELECT created_at FROM observations ORDER BY created_at_epoch ASC LIMIT 1
   }
   ```

   Match the existing prepared-statement pattern in that directory.

3. Wire the helper into `handleGetStats` and surface as ISO string (or `null` if no observations). Verify the existing TypeScript type for the stats response is updated.

### Verification

- `bun test tests/sqlite/observations.test.ts` still passes.
- New unit test in `tests/sqlite/observations.test.ts` (or a new file) covering `getFirstObservationCreatedAt` for empty + non-empty DB.
- `curl http://localhost:$PORT/api/stats` returns the new field.

### Anti-pattern guards

- Do NOT add new endpoints — extend the existing `/api/stats` payload.
- Do NOT add per-project earliest-timestamp logic; the viewer stat row is global ("X observations · Y projects · since [date]").

---

## Phase 5 — Viewer WelcomeCard Rewrite

**Why:** Current card is generic and doesn't differentiate the empty state (the moment the user is asking "is anything happening?") from the data state (the moment the user is asking "what can I do here?").

### Tasks

1. **App.tsx wiring** (`src/ui/viewer/App.tsx:128-130`). Pass new props to `WelcomeCard`:
   ```tsx
   <WelcomeCard
     onDismiss={...}
     observationCount={allObservations.length}
     projectCount={projects.length}
     isConnected={isConnected}
     firstObservationAt={stats.firstObservationAt}  // new — fetched from /api/stats
   />
   ```
   If a stats fetch hook doesn't already exist, add one (`useStats()` at `src/ui/viewer/hooks/useStats.ts`) that polls `/api/stats` on mount and on each new SSE observation.

2. **WelcomeCard.tsx rewrite** (`src/ui/viewer/components/WelcomeCard.tsx`):
   - Bump localStorage key to `claude-mem-welcome-dismissed-v2` (keep helpers in same file). v1 dismissals should NOT carry over — the card is meaningfully different.
   - Branch on `observationCount === 0`:
     - **Empty state:**
       - Headline: "No observations yet."
       - Body: "Open Claude Code in any project — entries stream in here as Claude reads, edits, and runs commands."
       - Live status row with a `<span class="welcome-card-status-dot" data-connected={isConnected ? 'true' : 'false'} />` and label "Connected to worker · waiting for activity" / "Reconnecting…" based on `isConnected`.
       - Footer: "How it works" link + dismiss button (existing behavior).
     - **Has-data state:**
       - Headline: "claude-mem"
       - Body: "Persistent memory across Claude Code sessions."
       - Stat row: `${observationCount} observations · ${projectCount} projects · since ${formatDate(firstObservationAt)}`.
       - Two example prompts (cut from four):
         - `<code>ask:</code> did we already solve X?`
         - `<code>/mem-search</code> dig into past work`
       - Footer: "How it works" + "Read the docs" links + dismiss.
   - "How it works" link points to `/api/onboarding/explainer` (opens in new tab as raw markdown — acceptable for v1; or a small modal showing the markdown rendered).

3. **CSS additions** in `src/ui/viewer-template.html` next to `.welcome-card-*` styles (lines 1443-1561). Reuse existing `@keyframes pulse` (line 754). Add:
   - `.welcome-card-status-dot` (8×8 circle, error color + pulse when disconnected, success color + no animation when `data-connected="true"`).
   - `.welcome-card-stats` (single-row, dim text, dot separators using `·`).
   - `.welcome-card-empty` adjustments (slightly larger lede, status row layout).

4. **Auto-dismiss on first observation:** in App.tsx, add an effect that flips the card from empty→has-data view automatically when `observationCount` crosses 0→1. The card should NOT auto-dismiss permanently on the first observation — it just transitions states. The user explicitly dismisses with the X.

### Verification

- `npm run build-and-sync` succeeds; viewer bundle rebuilds.
- Open viewer in a fresh-install state: empty card shows, dot animates (or is solid green if connected).
- In Claude Code, do one Read in a project. The viewer card flips to has-data state without a manual refresh, stat row populates.
- Dismiss persists across reload (localStorage v2 key).
- Header "Show help" button still re-opens the card.
- Tests: a small unit test for `getStoredWelcomeDismissed` / `setStoredWelcomeDismissed` against the new v2 key (extend the helper logic — pure functions are easy to test even without React Testing Library).

### Anti-pattern guards

- Do NOT add a new CSS file. All styles in `viewer-template.html`.
- Do NOT poll `/api/stats` on every render — once on mount + on `'new_observation'` SSE event is enough.
- Do NOT auto-permanently-dismiss on first observation; users may want to keep the card visible for the example prompts.
- Do NOT inline the explainer text into the card — link to `/api/onboarding/explainer`.

---

## Phase 6 — Drift Audit

**Why:** Three surfaces, two verbatim lines, one explainer source. Catch any divergence before it ships.

### Tasks

1. Grep for the timing line and assert it appears verbatim in:
   - `src/services/worker/http/routes/SearchRoutes.ts` (Phase 2)
   - `src/npx-cli/commands/install.ts` (Phase 3)
   - `src/services/worker/onboarding-explainer.md` (Phase 1)

   ```bash
   grep -rn "Memory injection starts on your second session in a project" src/ plugin/
   # expect 3+ matches
   ```

2. Same for the privacy line (`Everything stays in ~/.claude-mem on this machine.`).

3. Confirm `/how-it-works` slash reference appears in install.ts and SearchRoutes.ts; SKILL.md exists at `plugin/skills/how-it-works/SKILL.md`.

4. Confirm WelcomeCard does NOT inline the explainer body — only the link.

5. Confirm no surface still says "/knowledge-agent" or "/mem-search" in install.ts post-install copy.

### Verification

- All grep checks pass.
- Manual: read all three surfaces side by side. Each is distinctly framed (install = two paths + first-success; SessionStart = third-person status; viewer = empty/has-data with live dot). The two verbatim lines and the `/how-it-works` link are the only repeated content.

---

## Phase 7 — End-to-End Smoke Test (manual)

**Why:** The acceptance criterion in the brief is a single coherent flow. This phase walks it.

### Steps

1. Fresh install:
   ```bash
   rm -rf ~/.claude-mem
   npx claude-mem install
   ```
   Verify: install Next Steps shows the new "Two paths" + first-success + timing + privacy + `/how-it-works` block.

2. Open the viewer at the printed URL. Verify: empty state shows, dot is green (connected) or red+pulsing (disconnected briefly).

3. Open Claude Code in any project. Type a prompt that causes one Read.
   - Verify in Claude Code: SessionStart context contains the new status note, NOT a "Welcome" block. Claude does not act on the bullets — at most relays them.
   - Verify in viewer: card flips to has-data state, stat row populates, observation appears in the feed.

4. End the session. Start a second Claude Code session in the same project.
   - Verify: SessionStart context this time contains injected past observations (not the welcome hint, since `observationCount > 0`).

5. Click the "How it works" link from the viewer card. Verify: it loads `/api/onboarding/explainer` markdown.

### Verification

All four observable beats in the acceptance criterion happen as described, in order, without any surface contradicting another on facts (timing, privacy, command names).

---

## Execution Order Summary

1. **Phase 1** (explainer + skill) — unblocks everything else by establishing the canonical content source.
2. **Phase 4** (`/api/stats` extension) — unblocks Phase 5; tiny isolated backend change, do it early.
3. **Phase 2** (SessionStart hint rewrite + default-pinning test) — independent, do in parallel with Phase 3.
4. **Phase 3** (install.ts Next Steps rewrite) — independent of Phase 2.
5. **Phase 5** (WelcomeCard rewrite) — depends on Phases 1 + 4.
6. **Phase 6** (drift audit) — runs after all copy changes land.
7. **Phase 7** (manual smoke) — final gate before commit/PR.

Phases 2, 3, and 4 are independent and could be parallelized in three short sessions if desired.

## Out of Scope (do not touch)

- Splash banner / installer animation work that just shipped on this branch.
- `/learn-codebase`, `/mem-search`, `/knowledge-agent` skill internals — only how we reference them.
- New viewer pages or routes beyond `/api/onboarding/explainer` and the `firstObservationAt` field on `/api/stats`.
- Public docs in `docs/public/` — covered by the existing Mintlify deploy; only update if a doc page directly contradicts the new copy.
