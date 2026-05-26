# Plan: Standing Directives — Capture & Management UX (cycle 2)

## Why
Standing Directives storage + injection shipped (plans/2026-05-25-standing-directives.md) and is
live. But a directive store nobody fills is dead. Alex loves plugin commands and wants to SEE them
fire. Give him three one-keystroke skills that drive the existing `/api/directive/*` worker API:
`/remember`, `/directives`, `/forget`. No new storage, no new endpoints — reuse what shipped.

## Implementer's standing rules (Alex's way)
- KISS + DRY + YAGNI: reuse the existing port-resolution snippet and the shipped HTTP API. Build
  only these three skills. No new endpoints, no auto-detection, no UI.
- Fail LOUD: if the worker is unreachable, say so plainly with the actual curl error — never fake
  a success message.
- NO code comments (the bash snippets in the skill bodies are instructions, not commented code).
- Cross-platform bash matching the existing skill style. Change only what's needed. Do not touch
  the directive storage/injection that already shipped.

---

## Phase 0 — Documentation Discovery (DONE — consolidated, sourced)

**Key correction:** claude-mem has NO `plugin/commands/` dir. User-facing commands ARE **skills**
(`plugin/skills/<name>/SKILL.md`), auto-discovered (no manifest entry), invoked as
`/claude-mem:<name>`. They receive the user's text as the skill's ARGUMENTS (same way mem-search /
make-plan received args this session). Synced to the installed marketplace by `npm run build-and-sync`.

**Template to copy:** `plugin/skills/timeline-report/SKILL.md` — a skill that resolves the worker
port and curls the worker HTTP API. Copy its frontmatter shape and bash idioms.

**Allowed APIs / exact snippets (verbatim, re-verify before use):**
- Frontmatter (timeline-report/SKILL.md:1-4):
  ```
  ---
  name: <skill-name>
  description: <what it does + trigger phrases>
  ---
  ```
- Worker port resolution (timeline-report/SKILL.md:25-31) — reuse VERBATIM:
  ```bash
  WORKER_PORT="${CLAUDE_MEM_WORKER_PORT:-$(node -e "const fs=require('fs'),p=require('path'),os=require('os');const uid=(typeof process.getuid==='function'?process.getuid():77);const fallback=String(37700+(uid%100));try{const s=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude-mem','settings.json'),'utf-8'));process.stdout.write(String(s.CLAUDE_MEM_WORKER_PORT||fallback));}catch{process.stdout.write(fallback);}" 2>/dev/null)}"
  ```
- Worktree-aware project derivation (timeline-report/SKILL.md:35-54) — reuse for project scoping:
  ```bash
  git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null)
  git_dir=$(git rev-parse --git-dir 2>/dev/null)
  if [ -n "$git_common_dir" ] && [ "$git_dir" != "$git_common_dir" ]; then
    project=$(basename "$(dirname "$git_common_dir")")
  else
    project=$(basename "$PWD")
  fi
  ```
  (The context hook uses `getProjectContext(cwd)` → `allProjects` = `[parent, parent/child]` for
  worktrees, `src/utils/project-name.ts:48-69`. For directive PROJECT scope, use the parent
  `project` basename above — directives should apply across a project's worktrees.)
- Worker HTTP (shipped this run, src/services/worker/http/routes/DirectiveRoutes.ts:9-71):
  - `POST /api/directive/add` body `{ content: string(min1), scope?: 'global'|'project'(default
    global), project?: string }` (project required iff scope=project) → `{ success, id, content,
    scope, project }`.
  - `GET /api/directive/list?projects=a,b` → `{ directives: [{ id, content, scope, project,
    status, created_at, ... }] }`. Omitting projects returns globals only.
  - `POST /api/directive/archive` body `{ id: number }` → `{ success, id }` or 400
    `{ error: "Directive <id> not found" }`.

**Anti-patterns:** do not create a `plugin/commands/` dir; do not add a new endpoint; do not
hardcode port 37777; do not swallow a curl failure.

---

## Phase 1 — Author the three skills

Create three new skill dirs under `plugin/skills/`. Each SKILL.md: frontmatter + a short body that
(1) resolves `WORKER_PORT` (snippet above), (2) derives `project` if needed, (3) curls the API,
(4) checks the response and reports plainly, failing loud if the worker is down.

### 1. `plugin/skills/remember/SKILL.md`
- Frontmatter description triggers: "remember this", "/remember", "always …", "from now on …",
  "save this as a rule", "make this a standing directive".
- Body: the rule text is the skill ARGUMENTS. Resolve port. Default `scope=global` (most behavioral
  rules are global). If the user clearly says "for this project" / "just here", set `scope=project`
  and include the derived `project`. POST to `/api/directive/add` with a JSON body built safely
  (use `node -e`/`jq`-free `printf` or a heredoc; ensure the content is JSON-escaped — prefer
  building the JSON with `node -e` using `JSON.stringify` to avoid quoting bugs). On `success`,
  tell the user: saved as directive #id, scope, and that it will now appear at the TOP of every
  future session. On failure (non-200 / no `success`), print the actual response and say the
  worker may be down — do not claim success.
- Add one line guiding the AGENT: "When the user states a durable rule mid-task, you may invoke
  this skill to persist it." (Mirrors the SKILL.md guidance added in cycle 1.)

### 2. `plugin/skills/directives/SKILL.md`
- Triggers: "/directives", "list my directives", "show standing directives", "what rules do you
  have".
- Body: resolve port + derive project; `GET /api/directive/list?projects=<parent-project>` (URL-
  encode). Parse JSON and pretty-print a numbered list: `#<id> [<scope>] <content>`. If empty, say
  so and hint `/remember <rule>`. Tell the user they can remove one with `/forget <id>`. Fail loud
  if the request errors.

### 3. `plugin/skills/forget/SKILL.md`
- Triggers: "/forget <id>", "remove directive", "archive directive", "delete that rule".
- Body: id is the ARGUMENTS. Resolve port. `POST /api/directive/archive` with `{ "id": <n> }`.
  On `success` confirm removed (it won't appear in future sessions). On 400 not-found, relay the
  error and suggest `/directives` to see valid ids. Fail loud on worker error.

**JSON-safety note (DRY/correctness):** build request bodies with
`node -e 'process.stdout.write(JSON.stringify({content: process.argv[1], scope: "global"}))' "$TEXT"`
piped to `curl --data @-` so arbitrary rule text (quotes, newlines) can't break the JSON. Use the
same idiom in all three skills.

**Verification checklist (Phase 1):** each SKILL.md has valid frontmatter (name+description); bodies
reuse the exact port snippet; no plain `localhost:37777` hardcode; no swallowed curl errors
(`curl -fsS` or explicit status check + echo on failure).

---

## Phase 2 — Build, sync, verify live

1. `npm run build-and-sync`; confirm exit 0 + worker restart + `/health` ok on the resolved port.
2. Invoke (or simulate the skill bodies') against the live worker:
   - remember: save "VERIFY-UX: think before implementing" (global) → expect `{success,id}`.
   - directives: list → the rule appears with its id.
   - inject: `curl '/api/context/inject?projects=<this-project>'` → "⚡ STANDING DIRECTIVES" block
     with the rule is FIRST.
   - forget: archive that id → `directives` no longer lists it; a fresh inject no longer shows it.
3. CLEANUP: ensure the VERIFY-UX directive is archived; live DB left clean.
4. Anti-pattern grep on the new files: no `localhost:37777` literal, no comments, no swallowed
   failures. Confirm no source other than the 3 new skill dirs changed (plus, if needed, a docs
   mention — but YAGNI; skip).

---

## Out of scope (YAGNI)
- Editing directives in place (archive + re-add is enough). Priority/reordering. Viewer UI for
  directives. Auto-detecting rules from corrections (the agent can call /remember; no NLP).
