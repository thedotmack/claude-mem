# The Memory Prize Scorecard: 17 Hackathon Projects, Judged on How They Actually Use Claude-Mem

*August 23, 2026. Seventeen submissions to the $1,000 "Build an agentic tool that actually remembers" challenge, each cloned, read, and scored on five axes: integration depth, category fit, does it work, would someone use it Monday morning, and does the README tell the truth. Every score below comes with the file and line that justifies it.*

## How the judging worked

Claude-Mem is a second agent that watches your main coding agent work, writes structured observations into a local SQLite database, and hands a titles-first timeline back at the start of the next session. The prize asked hackers to build on top of that: warm boots, timeline-driven retrieval, memory UIs, integrations with other tools, custom ingestion modes, real-time reactions to observations, or token-saving speed plays. The tiebreaker: would a real developer reach for it on a Monday.

We cloned all seventeen repositories, read every file that touched claude-mem, and traced each claimed integration to the exact line of code. Then we asked five questions and scored each from zero to five:

1. **Integration depth.** Zero means claude-mem appears nowhere. One means it is name-dropped in docs. Two means a shallow read of the SQLite database or a single HTTP call to the worker. Three means real reads and writes of observations inside the product's core loop. Four means multiple surfaces: hooks, modes, search, timeline, skills. Five means claude-mem is the architecture and the product would not exist without it.
2. **Category fit.** How squarely the project lands one or more of the seven prize categories.
3. **Working.** Zero is vaporware. Three runs with setup. Five is demoable end-to-end with tests.
4. **Monday morning.** The tiebreaker. Would a developer actually use it.
5. **Honesty.** Does the README match the code. Five means it matches. One means the pitch describes something the code does not do.

The headline finding before we get to the projects: nobody scored a four or five on integration depth. Not one project used claude-mem's timeline, its get_observations tool, its MCP search server, or hooked into its observer. Every single repository arrived as one squashed commit dated the day of the hackathon. And the most common failure was not ambition. It was plumbing: wrong port numbers, wrong route names, wrong settings keys, and worker calls that silently returned nothing while the pitch deck said "real, working."

Here are the seventeen, ranked from the top.

---

## 1. Temporal (seanowww/temporal-clean) — 20 out of 25

**What it does.** Temporal is a provenance layer for pull request review. It ingests GitHub PR and commit events plus evidence from Slack, Jira, Notion, Claude Code, and Codex into a graph, runs a scored traversal outward from the PR, and renders an evidence-backed timeline that a GitHub Action can post as a PR comment. The pitch: when you review a PR, you should see not just the diff but the decisions, conversations, and agent reasoning that led to it.

Claude-mem is one of seven connectors. Instead of ingesting raw agent transcripts, Temporal reads claude-mem's already-compressed observations, session summaries, and user prompts, so agent decisions land on the timeline already distilled.

**Why it should win.** This is the only submission where claude-mem's actual data model is understood and load-bearing. The client at `lib/claude-mem/client.ts` derives the worker port with the same formula claude-mem itself uses, pages through `/api/observations`, `/api/summaries`, and `/api/prompts` honoring the `hasMore` flag, and unwraps the response envelope correctly. When the worker is down it falls back to opening `~/.claude-mem/claude-mem.db` directly, read-only, guarding every column name with a `PRAGMA table_info` check so schema drift does not break it.

The normalization layer is where it gets thoughtful. Observation types drive artifact importance: a decision scores five, a change scores two. Session summary next-steps become QA checks. Anything wrapped in private tags is stripped at the boundary. Codex sessions are routed to Temporal's Codex source by reading claude-mem's `platform_source` field. And because claude-mem observations carry no branch information, the team wrote a Claude Code SessionStart and PostToolUse hook that logs git state to a sidecar file, then resolves each observation to the branch in effect at its timestamp. File overlap between an observation's `files_modified` and the PR's changed files adds retrieval score.

Forty-seven of forty-seven tests pass. Fourteen of them are claude-mem specific and cover both transports, the branch resolution, private-tag stripping, and end-to-end artifact assembly from a claude-mem export. TypeScript compiles clean. The README's claude-mem section matches the code line for line.

**Why it should lose.** Claude-mem is optional. The product runs fully without it, and the polished demo fixtures contain zero claude-mem records, so the demo path never exercises the integration. It is read-only: nothing writes back, no custom mode, no use of search or timeline retrieval. There is a dead branch in the port resolution that reads a settings key claude-mem does not store. And it is one connector among seven rather than the architecture.

**Where it landed and why.** First place. Integration depth three, category fit four, working five, Monday morning three, honesty five. It squarely lands "build an integration," partially lands "ingest anything," and is the only project that treats claude-mem's observation structure as something worth understanding rather than a blob to count or truncate.

---

## 2. TeamBrain (MrFibonacc1/yc-hacks-greptileFast) — 18 out of 25

**What it does.** TeamBrain pools multiple engineers' memories into a shared per-team brain. A zero-dependency Bun server ingests each engineer's claude-mem database, attributes every memory to its author, and injects a team briefing at session start. It also ingests Greptile and PR review conversations as memories, "graduates" recurring lessons into cross-team patterns, and runs a PR sentinel that flags diffs repeating a mistake another team already made. The tagline: Claude-Mem makes one engineer's agent smart; TeamBrain makes the whole team's.

**Why it should win.** It is the most ambitious and the most category-dense submission. It hits warm boot, memory UI, integration, and ingest-with-custom-mode all at once. The claude-mem integration speaks three of claude-mem's formats correctly. It reads `~/.claude-mem/claude-mem.db` directly with a resume cursor and refuses sensitive-typed rows. It implements a client for the cmem.ai cloud sync-hub wire API, and the route and headers match claude-mem's sync-hub worker. And it ships a custom mode, `modes/code--team.json`, that uses claude-mem's double-dash parent inheritance correctly; we verified every prompt key, type ID, and concept ID in the override against the real `code.json`.

One hundred ninety-eight of one hundred ninety-eight tests pass. We booted the server, created a brain, ran the SessionStart hook, and ran the MCP server end to end. The dashboard has a "Pool in Claude-Mem" panel. The preflight code even records "unproven" for the cloud paths rather than claiming them.

**Why it should lose.** The headline import path is broken on a real install. The importer at `server/src/cmem.ts:430` prefers a table called `memory_items` whenever it exists. On a stock claude-mem v13 install that table exists but is empty; the data lives in `observations`. We ran the import against a real database with over a hundred thousand observations and got back `opsScanned: 0, imported: 0`. The test fixture only builds the legacy tables, so the suite cannot catch this. The project scope filter is applied in the wrong branch too, so the hook's guard against pooling your entire history into whatever brain is active is a no-op.

Beyond the bug: it is a sibling memory system that ingests claude-mem rather than building on it. The plan document says outright "implement our own thin hooks and server." It does not use the worker API, the MCP search tools, or the timeline. The custom mode is format-correct but ships uninstalled with a note to copy it by hand. The cloud sync path was only ever tested against a stub.

**Where it landed and why.** Second place. Integration depth three, category fit four, working four, Monday morning three, honesty four. A team lead would genuinely want this. The award should be conditional on a one-line fix: prefer `observations` when `memory_items` is empty.

---

## 3. RegressionForge (KaushikSiva/regression-forge, plus demo-ecom-store) — 16 out of 25

**What it does.** A post-deployment regression gate. A FastAPI backend drives Playwright through a storefront checkout, then verifies the order via API, the confirmation email via Mailpit, the fulfillment webhook, and the correlated logs in SigNoz. It emits a deterministic PASS, FAIL, or NEEDS_REVIEW certificate with a React evidence room. A companion repo, ForgeCart, is the deliberately breakable target with good, broken, and fixed contract variants and a GitHub Actions workflow that blocks PRs on certification.

**Why it should win.** This is the only team that stood up claude-mem's server-beta runtime. The Dockerfile clones claude-mem pinned to a specific commit, and the Render manifest provisions Postgres, Valkey, a web service with API-key auth, and a worker. The Python client hits `/v1/projects`, `/v1/search`, and `/v1/memories`. We verified the payload shapes against claude-mem's actual route handlers and they match exactly. The calls sit inside the core `execute()` loop: recall before the browser steps, save after the run completes. Matches feed into the Codex diagnosis bundle and render in a MemoryRail in the UI. Unit tests mock the HTTP layer and assert the exact URLs, bearer header, and payloads. Every unavailable state is surfaced rather than faked.

**Why it should lose.** The recall query is a hardcoded literal: `"RegressionForge PASS"`. Not scoped to the workflow, the deployment, or the failure text. The content that comes back is the product's own JSON summary echoed through a full-text index, not observer-generated observations; Chroma and generation are both disabled, so there is no semantic search and the provisioned Anthropic worker never does anything. The README's architecture diagram shows memory feeding the gate, but the gate is `decide(step_results)` and memory never touches it. Local `make demo` never wires claude-mem at all; the memory path exists only on a manually bootstrapped Render deployment we could not verify live. The demo store repo has zero claude-mem code.

**Where it landed and why.** Third. Integration depth three, category fit three, working three, Monday morning three, honesty four. A genuinely wired, contract-correct, but shallow use of claude-mem as a hosted key-value and full-text store bolted onto a strong deploy-gate product that would work identically with any database.

---

## 4. Rewind (Ashutosh-Brain/greptile-fasthackathon-26) — 16 out of 25

**What it does.** A Codex-first context record. It watches OpenAI Codex tasks via the App Server, correlates their evidence with git commits, stores an evidence-backed record as a git note and in Supabase, and lets teammates inspect decisions, add rebuttals, and fork a corrected replay in an isolated worktree. Electron plus Next.js, with a local HTTP companion.

**Why it should win.** The claude-mem client is accurate. It resolves the worker from settings or the environment with the correct port formula, hits `/api/health`, `/api/stats`, `/api/processing-status`, `/api/observations`, `/api/summaries`, and `/api/prompts`, and every one of those routes exists with the field shapes it expects. It normalizes everything into a typed `memory.json` written beside each Codex trace. The README is unusually candid: claude-mem is "optional," "a separate enrichment layer, never over the source trace." The results document openly separates "plugin installed" from "worker connected" from "hooks capturing" from "compression authenticated" and admits compression never ran because an OAuth session had expired.

**Why it should lose.** Nothing reads `memory.json`. We grepped the UI, the context record, the Codex Q&A, the Supabase schema, and the GitHub comment generator: zero consumers. It is write-only dead data. The UI shows a status card with a version number and counts, never an observation. The film preflight gates the demo on the worker showing "Connected" even though its data contributes to no scene; the card exists to appear in the closing lockup. Per the team's own results, the only real end-to-end artifact was one raw captured prompt; zero compressed observations ever flowed through. Tests mock fetch entirely.

**Where it landed and why.** Fourth, tied on points with RegressionForge but ranked below it because RegressionForge actually reads memory back. Integration depth two, category fit two, working four, Monday morning three, honesty five. A well-built Codex tool wearing a truthful, correctly implemented, write-only claude-mem badge.

---

## 5. SourceTether (abheeshtroy/sourcetether) — 15 out of 25

**What it does.** A source-verified memory gate. It binds a hand-written atomic claim like "gravity is a static property initialized to 9.81" to a TypeScript declaration via a structural AST fingerprint, a SHA-256 over the parser tree ignoring comments and whitespace. Before releasing the memory, it re-verifies the fingerprint against current source. If the declaration changed, the memory is withheld and a precise re-read target is returned instead. A canvas lunar lander demo shows a controller using stale Earth-gravity memory running out of fuel while a revalidated one soft-lands.

**Why it should win.** The idea is genuinely relevant to memory staleness, which is a real problem nobody else in the field addressed. Forty-two of forty-two tests pass and TypeScript is clean; we ran them. The one claude-mem call, a GET to `/api/observation/{id}`, has a field mapping we verified against the worker's route handler. The README is brutally honest: it says it "fetches one local Claude-Mem observation only to establish provenance," "does not derive the claim automatically," and has an explicit limitations section.

**Why it should lose.** The observation content is deliberately discarded. The demo workflow copies the ID, timestamp, project, and session IDs and throws away the text; the stored claim is a hardcoded string constant. One test literally feeds in "Untrusted Claude-Mem narrative that must never be returned." The claude-mem dependency could be replaced by any object with an ID and a timestamp and nothing would change. The default port is 37701, which is the author's own uid-derived port, and the environment variable to override it is never documented. It binds one file, one symbol, one claim; there is no way to bind arbitrary observations to arbitrary symbols, and nothing ever flows back into an agent's context.

**Where it landed and why.** Fifth. Integration depth two, category fit two, working five, Monday morning one, honesty five. A clean, well-tested, honestly described AST gate that wears claude-mem as a provenance badge rather than using it as substrate.

---

## 6. Product Git (Luciayuanzhu/product-git) — 14 out of 25

**What it does.** Version control for product behavior. A stdio MCP server exposes six tools for a coding agent to begin a turn, declare impact, submit product state, and finish. A localhost web workbench lets a human accept, reject, or lock agent-declared changes to a Product Graph and save Product Versions. The next agent turn receives a scoped context pack with locked logic and a required code diff. It targets Codex as the host.

**Why it should win.** The product itself is real and tested: twenty-four tests plus an MCP smoke test pass. The claude-mem call works live; we verified it against a running worker. At the start of every turn it hits `/api/search` with a query built from the package name, framework, user request, and outstanding lock statements, and injects the result into the context pack as a "Director Note" shown beside the preview. The doctor command reports claude-mem availability and the connect command forwards the worker URL into the Codex MCP environment. The README is candid: "optional, fail-open, one advisory Director Note."

**Why it should lose.** The Director Note is the first six hundred characters of the raw search markdown, pipes and emoji and table header included, because the code truncates rather than compresses. The `source_refs` array is always empty because the code looks for a `results` key that the worker response does not have. No project filter is passed, so observations from unrelated projects leak into the note; we saw it happen. The root file named `claude-mem-adapter.js` is a legacy browser shim over product-git's own API that never touches claude-mem despite its name. An older PRD still shipped at root describes hook-based capture and demo observations that do not exist in code. And the host agent is Codex, so the agent using product-git is not the one whose work claude-mem records.

**Where it landed and why.** Sixth. Integration depth two, category fit two, working four, Monday morning two, honesty four. A real MCP governance product in which claude-mem is a single unscoped search call whose output is a truncated table in a side panel.

---

## 7. Relay (thehimalayanleo/relay) — 13 out of 25

**What it does.** A continuation protocol for handing off an in-progress investigation from one human-plus-agent pair to another. It seals a canonical JSON capsule of goal, decisions, rejected approaches, and next action behind a SHA-256 digest and an expiring capability URL, attaches an optional work pod, renders harness-specific resume prompts for Codex, Claude Code, Cursor, and OpenCode, and records an acceptance receipt. Greptile and Sail are the primary integrations.

**Why it should win.** The handoff protocol is thoughtful and well scoped. The claude-mem calls are correctly shaped: the port formula is right, the health check reads the real payload fields, and the search call takes the MCP-style text response and extracts observation IDs. The server exposes status and search endpoints, sessions persist the IDs, and a status pill shows "Claude-Mem, N recalled." The README and product focus doc are unusually candid about "no measured savings" and "empty memory shown honestly."

**Why it should lose.** The observation content is thrown away in the browser; only the ID numbers are posted back. Each capsule memory becomes the literal string "Claude-Mem observation N." And the adapters that render resume prompts omit memories entirely, so the recipient never sees even the IDs. The project name is hardcoded to "relay" in the client, so recall only ever works for a project literally named that. The "six memories sealed, warm-boots User 2" line in the demo capsule refers to Greptile fixtures, not claude-mem. Both claude-mem tests mock fetch. The team's own capsule admits the code was generated with Codex and the full test run is blocked on a Node 24 issue.

**Where it landed and why.** Seventh. Integration depth two, category fit two, working three, Monday morning two, honesty four. A real but skin-deep status-and-search probe that stores ID numbers and never puts any memory content in front of the person receiving the handoff.

---

## 8. FDE Harness (greptile-hackathon-demo/fde-harness) — 12 out of 25

**What it does.** A Next.js dashboard and Node pipeline for forward-deployed engineers. A Linear issue is decomposed into subtasks, matched against forty-two "change recipes" mined from real merged PRs using an embedding-free multi-axis scorer with abstention, then `claude -p` scaffolds code in a git worktree, TypeScript verifies it, and a draft PR is opened and written back to Linear. A second feature generates a customer handoff document from accumulated memory.

**Why it should win.** The retrieval engineering is strong and the internal docs are candid about cut lists and what would be "false" to claim. Claude-mem is written to at four points in the pipeline via the worker HTTP API with the correct per-user port formula: one observation per distilled recipe, one per plan-or-abstain decision, one per run outcome, one per correction. And there is one real read: the handoff generator opens `~/.claude-mem/claude-mem.db` directly, selects decision, bugfix, feature, and refactor observations for the project while excluding sensitive ones, and feeds them into a prompt to produce the handoff markdown. Exported data shows five real runs including one real draft PR.

**Why it should lose.** The loop that the project describes as its prize-winning feature, "corrections injected into the next generation," reads from the project's own SQLite corrections table, not from claude-mem. A code comment admits why: claude-mem's search had no exact concept filter. So claude-mem receives a copy of every correction that it never reads back. The project info document advertises four "load-bearing roles" for claude-mem; only the handoff is implemented against it, and two of the four describe API calls that do not exist anywhere in the code. Zero corrections exist in the exported data, so the headline chart is empty. The README is untouched create-next-app boilerplate. The handoff script depends on claude-mem's private SQLite schema rather than the API.

**Where it landed and why.** Eighth. Integration depth two, category fit two, working three, Monday morning two, honesty three. A strong retrieval project with claude-mem bolted on as an observation sink plus one real read path, not the memory substrate the docs describe.

---

## 9. Pinocchio (akhiping/yc-greptile, deployed at pinocchio-agent-verifier.onrender.com) — 12 out of 25

**What it does.** An agent verification tool. It captures a coding agent's diff and tool ledger, runs deterministic detectors for test tampering, assertion weakening, hardcoded literals, phantom test execution, and vacuous tests, and emits a contract JSON with a "nose length" score. It can block the agent's turn via a Codex Stop hook or a git pre-commit gate. The deployed app is an "Agent Truth Game" that replays recorded detector scenarios.

**Why it should win.** The detector idea is genuinely useful and the verifier claims sixty-six passing tests. The live site is up and serves real scenario data. The README is admirably upfront that claude-mem is "optional" and "the next integration surface, not a dependency." The intended warm-boot arc, where a prior session's observation of assertion-weakening informs the next session's verification, is exactly the right idea for the prize.

**Why it should lose.** The claude-mem adapter, `pinocchio/cricket.py`, cannot connect to a real install. It reads a settings key called `port`; claude-mem stores `CLAUDE_MEM_WORKER_PORT`, so it returns nothing on every real machine. It POSTs to `/api/observations`, a route that does not exist for writing. It parses a `content` field that observations do not have. And it is only imported by a terminal demo script; the main entry points, the hooks, the gate, and the deployed server never touch it. The README's warm-boot terminal output was hand-written, not captured. The team's own planning docs show the claude-mem track was deliberately deprioritized: "only if prize real," and a damage report reading "Zero external dependencies. No claude-mem, no Chroma, no worker service." The deployed site runs in fallback replay mode with the Claude flag false and a memory count of zero.

**Where it landed and why.** Ninth. Integration depth two, category fit two, working three, Monday morning two, honesty three. A solid verifier with claude-mem bolted on as an aspirational, non-functional adapter on no shipped code path.

---

## 10. Lumina (charveeee/lumina) — 11 out of 25

**What it does.** A single-file FastAPI app and one HTML page. Difficult paragraphs get progressively simplified the longer a reader hovers over them, using rule-based sentence splitting and vocabulary substitution with no LLM. Each adaptation is tagged with a heuristic struggle pattern, and if claude-mem has recorded the same pattern three or more times for the session, the app jumps straight to the most aggressive rewrite.

**Why it should win.** For a four-hundred-fifty-line project, the wiring is correct. It POSTs to `/api/sessions/init` and `/api/sessions/observations` with fields that match claude-mem's real validation schema, so it genuinely feeds the observer pipeline rather than a made-up endpoint. It reads back via `/api/observations` using the right envelope key. It scopes one claude-mem project per browser session. It degrades cleanly when the worker is down. The README accurately says it "uses Claude-Mem's local worker API, does not maintain its own memory database." This is the "ingest anything" idea in miniature: non-coding telemetry pushed through the observer.

**Why it should lose.** The read path regex-counts a marker string inside compressed observations, and whether the default observer preserves that literal token through compression is never demonstrated. The read has a one-second timeout while the observer is an asynchronous LLM pipeline, so the three-plus recurrence cannot fire within a few hover cycles. Nothing retrieved is used except a tally; the observation's content is discarded. Four of the five sample paragraphs trigger the same two patterns via static regexes, so recurrence measures the fixture text, not the reader. Port 37701 is hardcoded. There are no tests. There is an unused OpenAI dependency contradicting the "no API key" claim.

**Where it landed and why.** Tenth. Integration depth two, category fit two, working two, Monday morning one, honesty four. An honest, tiny, correctly wired but superficial use of the worker API in which claude-mem functions as an event counter that could have been a Python dictionary.

---

## 11. Mayday (Kush614/mayday) — 11 out of 25

**What it does.** A black box flight recorder for OpenAI Codex sessions. A recorder wraps `codex exec` into a JSONL trace, an enricher extracts per-step assumptions, an incident engine maps a pasted stack trace through a line-history index to the step and false belief that caused it, and a Modal sandbox re-runs Codex with the corrected belief. React replay UI.

**Why it should win.** The product is real: twenty-nine test cases across five files, committed replay results, a Playwright UI check. And the docs are honest about claude-mem's role. The integrations document explicitly labels it "pitch garnish (optional, honest)." The claude-mem notes say "neither is load-bearing for the demo." Thematically it is a cousin of claude-mem, a durable record of an agent's reasoning with a timeline scrubber, and would be a natural fit for "ingest anything" if it wrote to claude-mem.

**Why it should lose.** It does not use claude-mem. Every mention is documentation or a sponsor card. The About page renders a static entry reading "claude-mem: build-time memory. Persistent memory across the Claude Code sessions that built Mayday." That is what it was: the dev tool the authors had running while writing the code. No code touches the database, the worker, the MCP tools, hooks, or modes. Claude-mem is not a dependency in any package manifest. The README headlines "every one of these is load-bearing" above a card that is not. The "committed golden trace" the README and CLAUDE.md call sacred is gitignored and absent.

**Where it landed and why.** Eleventh. Integration depth one, category fit one, working three, Monday morning two, honesty four. A polished Codex forensics project that used claude-mem as its authors' dev memory and says so.

---

## 12. Repo Radio (nithinaru/fasthack-yc-greptile) — 11 out of 25

**What it does.** A daily AI-generated podcast. It picks the fastest-rising GitHub repo by star velocity, fact-checks its README against source, has Qwen write a two-minute radio segment with a HYPE, REAL, or MIXED verdict, voices it with Kokoro on Modal, and plays it in a karaoke-style web player that highlights cited file lines as the host talks. A Stripe wallet lets listeners buy on-air questions. Host memory gives "previously on" callbacks across episodes and a sidebar shows the host's memory.

**Why it should win.** It is a fun, polished product with eleven baked episodes with audio and a live Modal deployment. The cross-episode callback feature genuinely exists and is audible. Episode two is about claude-mem itself and rated it MIXED. The PRD pre-authorized "fallback equals memory.json alone; claim only what runs," which is the right instinct.

**Why it should lose.** The real memory system is a hand-rolled `web/memory.json` the project writes and reads itself. The claude-mem worker call is broken three independent ways: it sends `?q=` where the worker expects `?query=`, then falls back to POSTing to a route that only accepts GET, then parses a `snippet` field that claude-mem results never contain. All three failures are caught and swallowed, so it has always returned an empty list. Yet the submission document claims "a real, working build: a local worker on 37777 is queried search-before-script." The code also asserts that the worker "has no HTTP write endpoint," which is false and was the justification for routing all writes to the JSON file. Episode one contains a "previously on" callback despite being the first episode. The PRD promises a claude-mem worker screenshot that is not in the repo. Greptile is in the same "designed for, not running" state.

**Where it landed and why.** Twelfth. Integration depth one, category fit two, working four, Monday morning two, honesty two. A polished podcast product where claude-mem is a sponsor sticker on a homegrown JSON file, and the submission says otherwise.

---

## 13. Versionless (taranggoyal70/versionless, deployed at versionless-navy.vercel.app) — 11 out of 25

**What it does.** A proof layer for coding agents. It clones a target repo, SHA-256 hashes the locked test, lockfile, and config paths, lets Codex edit exactly one allowed file, then re-applies the patch in a second clean clone and re-runs the locked suite to prove the agent did not rewrite the tests. The live deploy is a hosted replay of a pre-recorded run behind a Clerk sign-in wall.

**Why it should win.** The locked-hash idea is genuinely useful and the Codex proof engine has real tests. The record path POSTs to `/api/sessions/observations` with a payload shape that matches claude-mem's validation schema, including a custom `VersionlessVerification` tool name with outcome and hashes, which is a reasonable "ingest anything" gesture. The README is candid: "Claude-Mem and Modal are not presented as active integrations because their local runtimes were unavailable during this build."

**Why it should lose.** The recall path gates on `GET /api/health`, but the worker serves `/health`; `/api/health` exists only on the separate server runtime. So against the current worker every run reports "memory unavailable" regardless of state. No test touches either claude-mem function. And then there is the hosted replay: `src/lib/migration/hosted-replay.ts` hardcodes `provider: "Claude-Mem", status: "replayed", itemCount: 3, summary: "Replaying memory captured during the verified local Codex run."` That row renders under a dossier heading reading "Repository intelligence and memory are real" with a pass mark. The README says no memory was ever captured. The evidence-ready artifact count is padded by these sponsor rows. The landing page never mentions claude-mem; the card only appears behind sign-in.

**Where it landed and why.** Thirteenth. Integration depth two, category fit two, working two, Monday morning two, honesty three. A solid verification demo with claude-mem as a decorative, untested, admittedly never-connected side call, and a deployed replay that fabricates the evidence.

---

## 14. CleanMyAgents (naturetime10/CleanMyAgents) — 10 out of 25

**What it does.** A macOS menu-bar Electron app styled after CleanMyMac that acts as a human-in-the-loop guardian for OpenAI Codex. A forked Codex posts every prompt, tool call, and tool output to a local guardian service, which runs keyword rules, a noise skip list, and a tiny trigram-cosine similarity index, then pops a notch "island" for a human to allow or deny. A React web UI shows hook-injection token audits, a session trajectory viewer, and a Grok-powered deep scan of rollout logs.

**Why it should win.** The island UI is nice and the real-time tool-call gating rhymes with "fire on what it sees." Dropping lint runs and npm-fund noise to save turns rhymes with "speed play." The similarity and store modules have passing tests. There is no top-level README and the docs never mention claude-mem, so nothing lies about it.

**Why it should lose.** There is no claude-mem anywhere. Not name-dropped, not referenced, not configured. The only grep hits were inside a vendored ninety-seven megabyte copy of OpenAI's Codex repository, in OpenAI's own memories extension. The homegrown memory is a character-trigram embedding over a JSON file with a comment saying "swap for a real embedding model." Two server routes call functions that are defined nowhere and crash at runtime. The Hooks, Scan, and Trajectory tabs are mock-backed; one mock file says "every value is invented." The backend directory is an empty placeholder. And the deep scan ships the user's full Codex rollout log, up to five megabytes including any secrets in tool output, to a third-party Grok endpoint.

**Where it landed and why.** Fourteenth. Integration depth zero, category fit one, working three, Monday morning two, honesty four. A reasonably thought-through Codex guardian that is not a claude-mem project in any sense.

---

## 15. Outcome (zkortam/wingman) — 10 out of 25

**What it does.** A TypeScript monorepo that watches chat sessions of a deployed support agent, detects user-frustration signals like retries and restated constraints, clusters them into incidents, has an LLM generate a failing assertion, proposes a bounded config diff, verifies it, and applies it as a per-user or global override in Supabase. A self-healing agent-config loop. There is no README because the docs directory is gitignored.

**Why it should win.** The pipeline is well structured with eighteen test files, replay stubs, fixtures, and a Supabase migration. The "prior art" ledger, which stores fingerprint, diff, and outcome and fetches prior art by fingerprint into the fix prompt, is the right shape for a memory retrieval layer. It is a plausible slot where claude-mem search could go.

**Why it should lose.** Nothing fills the slot. The only claude-mem reference in the entire codebase is a class named `ClaudeMemLedger`, a seventeen-line pass-through that delegates to an injected `MemoryAdapter` interface. No implementation of that interface exists. The class is never instantiated; it is only re-exported. Every real wiring uses an in-memory or no-op ledger. The LLM stack is entirely OpenAI. There is no root package manifest or lockfile despite workspace dependencies, so the monorepo is not installable as committed. Naming a class after claude-mem while shipping zero claude-mem code is a name-drop designed to read as integration.

**Where it landed and why.** Fifteenth. Integration depth one, category fit one, working three, Monday morning two, honesty three. A competent config-repair pipeline that name-checks claude-mem in one identifier.

---

## 16. LingCode CLI (Xavierhuang/Mac_cli) — 7 out of 25

**What it does.** A Swift terminal CLI companion to the LingCode macOS IDE, with thirty-one subcommands. It routes prompts to the running app over a Unix socket or, standalone, spawns a bundled Node bridge around the Claude Agent SDK. The repo is explicitly a read-only mirror and release-binary host that does not build standalone; its package manifest depends on sibling directories that only exist in the canonical LingCode repository.

**Why it should win.** It is a legitimate, non-trivial agent CLI with real code and two test targets, and it makes no false claims: the README says nothing about claude-mem and is upfront that the mirror does not build.

**Why it should lose.** It has nothing to do with claude-mem. Zero hits across all eighty-four files including the nineteen-thousand-line vendored SDK bundle. What the broader search found is LingCode's own unrelated memory system: an in-process MCP server that writes markdown sections to a `.lingcode/memory.md` file, and whose requests are explicitly discarded on the CLI code path. There is no hackathon framing anywhere. It appears to have been submitted, or scraped, into the wrong pool.

**Where it landed and why.** Sixteenth. Integration depth zero, category fit zero, working one, Monday morning one, honesty five. Honest, and not a submission in any meaningful sense.

---

## 17. Sandhāna (shreekrithi1/epicenter) — 7 out of 25

**What it does.** A pre-existing proprietary enterprise "operational intelligence" SaaS. FastAPI and React, Postgres, a hundred-forty-plus connector catalog, Electron and mobile shells, Stripe billing. The repository root has two hundred forty-five entries including YC pitch decks, roadmap slides, a demo video, and eighty loose patch and test scripts. The README says "Founded 2024." It already had a "Team Memory" feature backed by regex fact extraction and a Postgres table.

**Why it should win.** The endpoints added for the hackathon do map one-to-one onto the prize category names: warm-boot, timeline, observations, ingest-anything, hooks, bench. The React memory page has warm-boot cards and timeline panels. A marketing page titled "Sandhāna × Claude-Mem, $1,000 Memory Prize Track" claims all seven categories.

**Why it should lose.** None of it touches claude-mem. Every new endpoint queries Sandhāna's own team-memories table and falls back to hardcoded seed memories whenever a user has fewer than three real ones. "Extraction" is a list of regexes: "we decided," "action item," "root cause." Token counts are string length divided by four. The "bridge" script POSTs Claude Code transcript events to Sandhāna's own API on localhost port 8000, never to claude-mem. The MCP tool descriptors are served by Sandhāna's own MCP endpoint. The pitch page claims warm-boot injection into chat that does not exist in the server code, claims an "Apache-2.0 bridge" under a repository whose license is "Proprietary, all rights reserved," and cites inflated star and commit counts for claude-mem. Its own footer concedes "not affiliated with Claude-Mem, built on its ideas." Git history is one squashed commit, so the hackathon delta cannot be dated. Every database write is wrapped in a silent exception swallow, so "extracted N memories" can report success without persisting anything.

**Where it landed and why.** Last. Integration depth one, category fit two, working two, Monday morning one, honesty one. A pre-existing product that renamed its regex memory endpoints in claude-mem's vocabulary and built a pitch page around the renaming.

---

## What the field tells us

**The plumbing is where everyone fell down.** Five teams independently reimplemented claude-mem's per-user port formula correctly. Two others hardcoded port 37701, the author's own uid-derived port. One gated on `/api/health` when the worker serves `/health`. Two read a settings key claude-mem does not write. One sent `q=` instead of `query=`. If there is a single documentation fix to make, it is a one-page "how to talk to the worker" reference with the port formula, the route list, and the response envelope.

**Read-and-discard was the dominant pattern.** Rewind, Relay, SourceTether, and Product Git all fetch real observations and then throw away the content, keeping an ID, a count, or a truncated string. The observation's title, facts, and narrative, the whole point of the compression step, never reached a user or an agent in any of them.

**Nobody touched the retrieval stack.** Timeline, get_observations, and mcp-search went unused across all seventeen. The "cheapest first" retrieval discipline the cheat sheet describes was not attempted by anyone. TeamBrain shipped the only custom mode, and it ships uninstalled.

**Honesty was mostly good, with two exceptions worth naming.** Most READMEs were candid about claude-mem being optional. Versionless hardcoded replay evidence its own README says never existed. Sandhāna built a pitch page whose claims are contradicted by its server code and its license file.

**The recommendation.** Temporal for the prize: the only entry where claude-mem's data model is understood and load-bearing, tested, and accurately described. TeamBrain as runner-up, conditional on the one-line fix that makes its import work against a real database. RegressionForge gets an honorable mention for being the only team to stand up the server runtime with a verified contract.
