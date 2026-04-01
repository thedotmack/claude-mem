# 200-Agent Benchmark: Implementation Plan

## Phase 0: Documentation Discovery (Complete)

### Allowed APIs

| API | Source | Signature |
|-----|--------|-----------|
| TranscriptParser | `src/utils/transcript-parser.ts:203-229` | `getTotalTokenUsage(): { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens }` |
| UsageInfo | `src/types/transcript.ts:13-20` | `{ input_tokens?, output_tokens?, cache_creation_input_tokens?, cache_read_input_tokens? }` |
| Transcript entries | `src/types/transcript.ts` | Types: `user`, `assistant`, `summary`, `system`, `queue-operation` |
| claude-mem install | `installer/src/steps/install.ts:95-167` | `npx claude-mem install` → clone → build → register marketplace → register plugin → enable |
| Worker health | `src/services/server/Server.ts` | `GET /api/health` (200 = alive), `GET /api/readiness` (503 until init) |
| Telegram send | OpenClaw pattern: `openclaw/src/index.test.ts:44-47` | `sendMessage(to: string, text: string): Promise<void>` |
| Bun test | `package.json:79` | `bun test` for unit/integration tests |

### Anti-Patterns to Avoid

- Do NOT assume `claude --headless` exists. Claude Code runs interactively; agents self-direct.
- Do NOT build two Dockerfiles. Single Dockerfile with `--build-arg MEMORY_TYPE=claude-mem|vanilla`.
- Do NOT hardcode API keys in images. Inject at runtime via env vars.
- Do NOT use shell scripts for orchestration. TypeScript only (Eng decision #7).
- Do NOT implement hard timeouts. Telegram + human kill switch only.
- Do NOT catch generic exceptions. Name every error class (Error & Rescue Map in PLAN.md).

### Key Decisions (locked, do not re-litigate)

1. Anthropic's official devcontainer as Dockerfile base
2. TypeScript orchestrator (not shell scripts)
3. Round-robin API key distribution (`agent_id % num_keys`)
4. Model pinning via `ANTHROPIC_MODEL` env var
5. YAML frontmatter in prompt files for config + smoke tests
6. 4-dimension rubric: functionality, code_quality, ux, completeness (1-9 scale)
7. Judge blinding: snapshot-based stripping at aggregation time
8. Telegram monitoring with human kill switch (no automated kills)
9. Publishable JSON output schema (defined in CEO plan v2)
10. Calibration set: 10-20 hand-scored examples, 75% agreement threshold

---

## Phase 1: Scaffold — Dockerfile, Prompts, Schemas

**Goal:** All static assets exist and validate. No runtime code yet.

### Tasks

#### 1.1 Dockerfile with build arg

Create `benchmark/Dockerfile`:

```dockerfile
# Base: Anthropic's official devcontainer (or Node 20 + Bun if unavailable)
# Check: https://github.com/anthropics/anthropic-quickstarts or ghcr.io/anthropics/
ARG MEMORY_TYPE=vanilla

# Install Claude Code (both arms)
# Claude Code CLI: npm install -g @anthropic-ai/claude-code

# Conditional: install claude-mem (only when MEMORY_TYPE=claude-mem)
RUN if [ "$MEMORY_TYPE" = "claude-mem" ]; then \
      npx claude-mem install; \
    fi

# Entrypoint: start Claude Code with the prompt
# The prompt file is mounted at /workspace/prompt.md
# Claude Code is invoked with: claude -p "$(cat /workspace/prompt.md)"
```

**Doc reference:** Eng decision #1 (PLAN.md:421), DRY single Dockerfile (PLAN.md:128-129).

**Anti-pattern guard:** Search for Anthropic's actual devcontainer image before using a generic Node base. Check `ghcr.io/anthropics/` and Anthropic's GitHub repos.

#### 1.2 Prompt files with YAML frontmatter (20 files)

Create `benchmark/prompts/` with all 20 prompt files. Each file follows:

```yaml
---
id: "01-twosidednews"
title: "TwoSidedNews"
category: "web"
timeout_hint: "4h"
industry_baseline:
  source: "none"
  reference_cost_usd: null
  reference_duration_seconds: null
  reference_architecture: null
smoke_tests:
  - name: "serves_on_port_3000"
    command: "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000"
    expect: "status:200"
  - name: "enter_topic_returns_articles"
    command: "curl -s http://localhost:3000/search?topic=climate"
    expect: "contains:article"
---

# TwoSidedNews

Build a news aggregation web app that shows two opposing viewpoints on any topic.

## Requirements
- Serves on port 3000
- User enters a topic
- App displays two columns of articles with opposing perspectives
- Each article has a title, source, and summary
- Responsive layout

## Testable Deliverable
Enter a topic, see two columns of opposing articles.
```

**Industry comparison prompts (4):**

| ID | Title | Category | Baseline Source | Baseline Cost | Timeout Hint |
|----|-------|----------|----------------|---------------|-------------|
| 17-retroforge | RetroForge Game Maker | fullstack | anthropic | $200 (3-agent) / $9 (solo) | 8h |
| 18-browser-daw | Browser DAW | fullstack | anthropic | $124.70 | 6h |
| 19-dutch-art-museum | Dutch Art Museum | frontend | anthropic | null (qualitative) | 4h |
| 20-design-desk | Design Desk | fullstack | openai | null (13M tokens) | 8h |

**Doc reference:** Prompt list in PLAN.md:305-349, prompt changes in CEO plan v2.
**Copy from:** Anthropic's exact prompt descriptions from their engineering blog post. OpenAI's Design Desk description from their published experiment.

#### 1.3 JSON output schema

Create `benchmark/schema/agent-result.schema.json` — JSON Schema for the publishable output format.

**Copy from:** CEO plan v2, "Publishable Output Schema" section (lines 136-178).

Fields: `schema_version`, `agent_id`, `arm`, `prompt_id`, `prompt_category`, `model_version`, `tokens` (5 sub-fields), `cost_usd`, `wall_clock_seconds`, `completion_status`, `smoke_tests` (total/passed/failed/skipped/results), `rubric_scores` (4 dimensions), `judge_blinded`, `industry_baseline`, `raw_log_sha256`.

#### 1.4 Rubric definition file

Create `benchmark/rubric.yaml` with the 4-dimension rubric and scoring anchors.

**Copy from:** CEO plan v2, "4-Dimension Evaluation Rubric" section (lines 83-92).

```yaml
dimensions:
  functionality:
    weight: 0.30
    anchors:
      1: "Does not start"
      3: "Starts, core feature broken"
      5: "Core features work"
      7: "All features work, minor bugs"
      9: "All features work, edge cases handled"
  code_quality:
    weight: 0.25
    anchors: ...
  ux:
    weight: 0.20
    anchors: ...
  completeness:
    weight: 0.25
    anchors: ...
```

#### 1.5 Environment template

Create `benchmark/keys.env.example`:

```env
# API keys — round-robin assigned to agents
ANTHROPIC_API_KEY_1=sk-ant-...
ANTHROPIC_API_KEY_2=sk-ant-...
# Add as many as you have

# Judge gets its own dedicated key
JUDGE_API_KEY=sk-ant-...

# Model pinning (exact version, no drift)
ANTHROPIC_MODEL=claude-opus-4-6

# Telegram monitoring
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=-100123456789
```

Add `benchmark/keys.env` to `.gitignore`.

### Verification Checklist

- [ ] `docker build -f benchmark/Dockerfile --build-arg MEMORY_TYPE=vanilla .` succeeds
- [ ] `docker build -f benchmark/Dockerfile --build-arg MEMORY_TYPE=claude-mem .` succeeds
- [ ] All 20 prompt files exist in `benchmark/prompts/` and parse as valid YAML frontmatter
- [ ] `benchmark/schema/agent-result.schema.json` is valid JSON Schema
- [ ] `benchmark/keys.env` is in `.gitignore`
- [ ] `grep -r "ANTHROPIC_API_KEY" benchmark/` returns 0 hits outside `.env.example`

---

## Phase 2: Orchestrator — Container Lifecycle + Key Distribution

**Goal:** TypeScript orchestrator that launches N Docker containers with correct env vars, assigns prompts, and manages lifecycle.

### Tasks

#### 2.1 Project setup

Create `benchmark/src/` as a TypeScript project:

```
benchmark/
├── src/
│   ├── orchestrator.ts      # Main entry point
│   ├── container-manager.ts  # Docker container lifecycle
│   ├── key-distributor.ts    # Round-robin API key assignment
│   ├── prompt-loader.ts      # YAML frontmatter parser
│   ├── types.ts              # Shared types (AgentConfig, RunResult, etc.)
│   └── config.ts             # CLI args, env vars, defaults
├── package.json
├── tsconfig.json
└── bun.lockb
```

Dependencies: `dockerode` (Docker API), `yaml` (frontmatter parsing), `zod` (schema validation).

**Doc reference:** Eng decision #7 (TypeScript, PLAN.md:427).

#### 2.2 Prompt loader

`prompt-loader.ts`:
- Read all `.md` files from `benchmark/prompts/`
- Parse YAML frontmatter (id, title, category, timeout_hint, smoke_tests, industry_baseline)
- Validate against a Zod schema
- Return typed `Prompt[]`

**Copy pattern from:** Any existing YAML frontmatter parser in the codebase (check `src/` for YAML usage).

#### 2.3 Key distributor

`key-distributor.ts`:
- Read `keys.env` → extract `ANTHROPIC_API_KEY_N` entries
- Round-robin assignment: `keys[agent_index % keys.length]`
- Judge gets `JUDGE_API_KEY` (separate, never in the pool)
- Pre-flight validation: test each key with a minimal API call before launching containers

**Doc reference:** PLAN.md:70-81 (API Key Distribution diagram), Error & Rescue Map (AuthError: pre-flight key validation).

#### 2.4 Container manager

`container-manager.ts`:
- Uses `dockerode` to create/start/stop/remove containers
- Each container gets:
  - Agent ID: `{arm}-{prompt_id}-{replica}` (e.g., `cmem-03-2`, `vanilla-03-2`)
  - Env vars: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `AGENT_ID`, `MEMORY_TYPE`
  - Volume mounts: prompt file → `/workspace/prompt.md`, results dir → `/workspace/results/`
  - Network: Docker bridge (containers can reach internet, not each other via Docker DNS isolation)
- Container health: poll `docker inspect` for running/exited/dead status
- Write `CRASHED.md` to results volume if container exits non-zero

**Doc reference:** Architecture diagram (PLAN.md:32-68), container isolation (PLAN.md:97-101).

#### 2.5 Orchestrator main loop

`orchestrator.ts`:
- Parse CLI args: `--phase 1|2`, `--prompts-dir`, `--keys-env`, `--replicas N`
- Phase 1: 1 replica per prompt per arm = 40 agents
- Phase 2: 5 replicas per prompt per arm = 200 agents
- Launch sequence:
  1. Load prompts
  2. Validate keys (pre-flight)
  3. Build Docker image (if not cached)
  4. Create agent configs (prompt × replica × arm)
  5. Launch containers (batched, e.g., 10 at a time to avoid Docker overload)
  6. Write `manifest.json` with all agent configs + start times
  7. Return control (containers run autonomously)

**Anti-pattern guard:** Do NOT implement polling or waiting in the orchestrator. Containers run autonomously. Judge agent (Phase 3) handles monitoring.

### Verification Checklist

- [ ] `bun run benchmark/src/orchestrator.ts --phase 1 --dry-run` prints agent configs without launching
- [ ] Key distributor rejects invalid keys (unit test: pass dummy key, verify rejection)
- [ ] Prompt loader parses all 20 prompts without error (unit test)
- [ ] Agent ID format matches `{arm}-{prompt_id}-{replica}` (unit test)
- [ ] Container manager creates/starts/stops a single test container (integration test)

---

## Phase 3: Judge Agent — Monitoring + Telegram

**Goal:** A judge process that runs every 10 minutes, evaluates each running agent's progress, and sends Telegram updates.

### Tasks

#### 3.1 Judge cycle runner

`benchmark/src/judge/judge-runner.ts`:
- Runs as a long-lived process (separate from orchestrator)
- Every 10 minutes:
  1. List running containers (from manifest.json + docker inspect)
  2. For each running agent, read its current state (see 3.2)
  3. Evaluate drift (see 3.3)
  4. Write evaluation to `results/{agent_id}/judge-log.jsonl`
  5. Send Telegram summary (see 3.4)
- Judge heartbeat: write timestamp to `results/.judge-heartbeat` every cycle
- Orchestrator checks heartbeat age; if >20 min stale, alert (Eng decision #3)

**Doc reference:** Judge Agent Design (PLAN.md:229-242), Eng decision #3 (PLAN.md:423).

#### 3.2 Container state reader

`benchmark/src/judge/state-reader.ts`:
- For each agent container, read from its results volume:
  - `DONE.md` — if exists, agent declares done
  - `CRASHED.md` — if exists, agent crashed
  - Last modified file timestamps (activity signal)
  - Git log from `/workspace/` (what has the agent committed?)
  - File count and structure (scaffolding signal)
  - Plan file (if the agent wrote one) — used as drift baseline
- Parse the agent's transcript JSONL for token counts and cost
  - Token cost calculation: use current Anthropic pricing per model
  - **Copy from:** `TranscriptParser.getTotalTokenUsage()` at `src/utils/transcript-parser.ts:203-229`

**Doc reference:** Results collection (PLAN.md:158-163), token measurement (PLAN.md:244-254).

#### 3.3 Drift evaluator

`benchmark/src/judge/drift-evaluator.ts`:
- Stage-aware evaluation (5 stages from PLAN.md:232-237):
  1. Planning: coherent plan exists, scoped to prompt?
  2. Scaffolding: right files/structure being created?
  3. Building: implementing what plan says?
  4. Integration: does it run?
  5. Polish: edge cases, tests passing?
- Infer stage from elapsed time + file activity:
  - 0-15 min → expect planning
  - 15-60 min → scaffolding
  - 1-3 hrs → building
  - 3-5 hrs → integration
  - 5+ hrs → polish
- Score: `on-track | minor-deviation | major-drift | unrecoverable`
- Log reasoning (not just score) for post-hoc review

**Anti-pattern guard:** Do NOT auto-kill agents. Drift assessment is informational. Human decides via Telegram.

#### 3.4 Telegram notifier

`benchmark/src/judge/telegram-notifier.ts`:
- Uses Telegram Bot API directly (HTTP POST, no SDK needed):
  ```
  POST https://api.telegram.org/bot{TOKEN}/sendMessage
  Body: { chat_id, text, parse_mode: "Markdown" }
  ```
- Message format per cycle:
  ```
  *Judge Cycle #N* (elapsed: Xh Ym)

  Running: 18 | Done: 1 | Crashed: 1
  Total cost: $45.23

  ⚠️ WARNING: cmem-17-1 (RetroForge) — major drift, $18.50, 2h 15m
  ℹ️ INFO: vanilla-01-1 (TwoSidedNews) — on track, $3.20, 45m
  ...

  /kill cmem-17-1 — to terminate
  /status — full breakdown
  ```
- Escalation tiers:
  - INFO: on-track, cost < expected
  - WARNING: drift detected OR cost > 2x expected
  - CRITICAL: stuck/looping (no file changes in 30+ min while running)

**Doc reference:** CEO plan v2, "Monitoring: Telegram" section (lines 68-81).

#### 3.5 Kill handler

`benchmark/src/judge/kill-handler.ts`:
- Polls Telegram for incoming messages (getUpdates long-polling)
- Recognizes commands: `/kill {agent_id}`, `/status`, `/cost`
- `/kill`: stops container via dockerode, writes `KILLED.md` to results volume
- `/status`: sends full agent breakdown
- `/cost`: sends running cost total + per-agent breakdown

### Verification Checklist

- [ ] Judge runner executes one cycle against a mock container (unit test with fixture data)
- [ ] State reader correctly parses transcript JSONL for token counts (unit test using `TranscriptParser` pattern)
- [ ] Drift evaluator returns correct stage for known elapsed times (unit test)
- [ ] Telegram notifier sends formatted message to test chat (integration test with real bot token)
- [ ] Judge heartbeat file is written and aged correctly (unit test)
- [ ] Kill handler stops a test container when `/kill` received (integration test)

---

## Phase 4: Evaluation — Smoke Tests + LLM Judge + Calibration

**Goal:** Post-completion evaluation pipeline: run smoke tests, then LLM judge scoring, with calibration validation.

### Tasks

#### 4.1 Smoke test runner

`benchmark/src/eval/smoke-runner.ts`:
- For each completed agent:
  1. Read prompt's YAML `smoke_tests` section
  2. Start the agent's container (or a fresh one from its committed code)
  3. Wait for app startup (poll health endpoint or fixed delay)
  4. Execute each smoke test command via `docker exec`
  5. Evaluate `expect` clause:
     - `status:200` → check HTTP status code
     - `contains:string` → check stdout contains string
     - `exit_0` → check exit code is 0
  6. Write results to `results/{agent_id}/smoke-results.json`
- Handle `smoke_tests: []` gracefully (skip, all tests = 0)

**Doc reference:** CEO plan v2, "Smoke Test Framework" section (lines 106-133).

#### 4.2 LLM-as-judge evaluator

`benchmark/src/eval/llm-judge.ts`:
- For each completed agent:
  1. **Blinding:** Copy project to temp dir, strip agent type identifiers:
     - Remove `~/.claude-mem/` directory
     - Remove MEMORY.md
     - Strip agent ID from filenames/content
     - Remove any claude-mem references from logs
  2. Construct judge prompt:
     - Include rubric definition (from `benchmark/rubric.yaml`)
     - Include prompt spec (what was the agent asked to build?)
     - Include project file listing + key file contents
     - Include smoke test results (objective data for the judge)
     - Ask for 4-dimension scores with reasoning
  3. Call Claude API (using `JUDGE_API_KEY`)
  4. Parse response: extract scores + reasoning
  5. Write to `results/{agent_id}/judge-scores.json`

**Rubric reference:** CEO plan v2, lines 83-92.

**Anti-pattern guard:** Do NOT use catch-all error handling for API calls. Name each failure: `RateLimitError`, `TimeoutError`, `MalformedResponseError`, `RefusalError`.

#### 4.3 Calibration framework

`benchmark/src/eval/calibration.ts`:
- **Calibration set:** `benchmark/calibration/` directory with 10-20 hand-scored example projects
  - Each has: project files + `human-scores.json` (4-dimension scores by human reviewer)
- **Calibration run:**
  1. Run LLM judge on each calibration project (blinded, same prompt as real eval)
  2. Compare LLM scores vs. human scores (exact-match per dimension)
  3. Calculate agreement percentage
  4. If >= 75%: PASS, proceed with evaluation batch
  5. If < 75%: generate few-shot examples from disagreements, update judge prompt, re-calibrate
  6. Max 3 iterations. If still < 75%: proceed with WARNING, increase human spot-check
- Output: `benchmark/calibration/calibration-report.json`

**Doc reference:** CEO plan v2, "Calibration Methodology" section (lines 96-102).

**Note:** The calibration set is empty at first. Phase 1 runs produce the first projects to hand-score. Calibration validation happens before Phase 2 evaluation.

### Verification Checklist

- [ ] Smoke runner correctly evaluates `status:200`, `contains:X`, and `exit_0` expectations (unit test with mock docker exec)
- [ ] LLM judge produces valid 4-dimension scores for a sample project (integration test)
- [ ] Blinding correctly strips agent type from project files (unit test: cmem project → stripped, grep for "claude-mem" returns 0)
- [ ] Calibration framework calculates agreement percentage correctly (unit test with known scores)
- [ ] Calibration handles < 75% case: generates few-shot examples, retries (unit test)

---

## Phase 5: Analysis — Aggregation + Baselines + Publishing

**Goal:** Aggregate all results, compare against industry baselines, produce publishable dataset.

### Tasks

#### 5.1 Results aggregator

`benchmark/src/analysis/aggregator.ts`:
- For each agent, read:
  - `results/{agent_id}/smoke-results.json`
  - `results/{agent_id}/judge-scores.json`
  - `results/{agent_id}/judge-log.jsonl` (last entry for completion status)
  - Transcript JSONL for token counts (via `TranscriptParser` pattern)
  - Container metadata (start time, end time, exit code)
- Produce one `agent-result.json` per agent (matching `benchmark/schema/agent-result.schema.json`)
- Validate each output against the JSON schema
- Produce `benchmark/results/summary.json` with aggregate stats:
  - Per-arm: mean/median/p95 for tokens, cost, wall clock, rubric scores, smoke pass rate
  - Per-prompt: same breakdowns
  - Per-category: same breakdowns

**Copy from:** TranscriptParser at `src/utils/transcript-parser.ts:203-229` for token counting.

#### 5.2 Industry baseline comparison

`benchmark/src/analysis/baseline-compare.ts`:
- Load industry baselines from prompt YAML frontmatter (`industry_baseline` field)
- For prompts with baselines, produce comparison table:
  ```
  | Prompt | Arm | Our Cost | Baseline Cost | Delta | Our Quality | Notes |
  |--------|-----|----------|---------------|-------|-------------|-------|
  | RetroForge | cmem | $X | $200 (Anthropic 3-agent) | -X% | 7.2/9 | Single-agent vs 3-agent |
  | RetroForge | vanilla | $Y | $200 (Anthropic 3-agent) | -Y% | 6.1/9 | Single-agent vs 3-agent |
  | Design Desk | cmem | $Z | ~$650* (OpenAI est) | ... | ... | Token count: ours vs 13M |
  ```
- Include the Architectural Comparability Note prominently (these are reference points, not controls)

**Doc reference:** CEO plan v2, "Architectural Comparability Note" (lines 56-66) and "Reference: Industry Published Data" (lines 186-212).

#### 5.3 Output sanitizer

`benchmark/src/analysis/sanitizer.ts`:
- Before publishing, sanitize all output files:
  - Strip patterns matching `sk-ant-*`, `ANTHROPIC_API_KEY`, env variable values
  - Strip file paths containing usernames (regex: `/Users/[^/]+/`, `/home/[^/]+/`)
  - Strip common secret patterns (tokens, passwords, connection strings)
- Compute SHA-256 hash of raw logs BEFORE sanitization (for publication credibility)
  - Store hash in `agent-result.json` → `raw_log_sha256` field
- Write sanitized files to `benchmark/results/publishable/`

**Doc reference:** CEO plan v2, "Output sanitization" (line 180-184), TODOS.md sanitizer test fixture.

#### 5.4 Report generator

`benchmark/src/analysis/report.ts`:
- Produce `benchmark/results/report.md` with:
  - Executive summary (headline numbers)
  - Methodology description
  - Per-arm comparison (tables + text)
  - Industry baseline comparison
  - Per-prompt breakdown
  - Statistical notes (variance, confidence intervals if Phase 2 data)
  - Calibration report summary
  - Known limitations

### Verification Checklist

- [ ] Aggregator produces valid JSON matching schema for each agent result (unit test with fixture data)
- [ ] Baseline comparison correctly matches prompts with industry data (unit test)
- [ ] Sanitizer strips all known secret patterns (unit test with synthetic secrets — the TODOS.md test fixture)
- [ ] SHA-256 hashes match between raw and sanitized assertions (unit test)
- [ ] Report generator produces readable markdown (manual review)

---

## Phase 6: End-to-End Verification

**Goal:** Run the confidence test and hostile QA test to prove the harness works before Phase 1.

### Tasks

#### 6.1 Confidence test (2 agents)

Run the simplest prompt (e.g., URL Shortener) with 1 cmem + 1 vanilla agent:
1. Both containers start
2. Both complete (write DONE.md)
3. Results are collected
4. Smoke tests run and produce results
5. LLM judge scores both
6. Aggregator produces valid JSON
7. Comparison report shows both arms with valid data

This is the "it works at all" test.

**Doc reference:** PLAN.md:269.

#### 6.2 Hostile QA test (5 agents)

Launch 5 agents:
1. 2 normal (expect: DONE)
2. Kill 2 mid-run via Telegram `/kill` (expect: KILLED status)
3. Let 1 hit a simulated rate limit (expect: delayed but complete)

Verify:
- 2 agents → DONE, full results
- 2 agents → KILLED, partial results with KILLED.md
- 1 agent → DONE (delayed), full results with inflated timing
- Aggregation handles all 5 states correctly
- Telegram received correct escalation messages during kills

**Doc reference:** PLAN.md:271-272.

#### 6.3 Phase 1 go/no-go criteria

Before scaling to Phase 2, verify (from CEO plan v2):
- >= 90% of Phase 1 agents complete without crashing
- Calibration agreement >= 75%
- At least 1 industry comparison prompt (RetroForge, DAW, Dutch Museum, or Design Desk) completes
- Smoke test framework executes without errors
- JSON output validates against schema for all completed agents
- Telegram monitoring received all expected judge cycles
- Cost per agent is within 2x of estimates (not a hard gate, but a sanity check)

### Verification Checklist

- [ ] Confidence test: both agents complete with valid scored results
- [ ] Hostile QA: all 5 states handled correctly in aggregation
- [ ] Telegram received kill confirmation messages
- [ ] JSON outputs validate against schema
- [ ] Phase 1 go/no-go criteria documented and checkable

---

## File Structure (Final)

```
benchmark/
├── Dockerfile                       # Single, with MEMORY_TYPE build arg
├── PLAN.md                          # Architecture + decisions (existing)
├── IMPLEMENTATION-PLAN.md           # This file
├── docker-compose.yml               # Optional, for local dev
├── keys.env.example                 # Template for API keys
├── rubric.yaml                      # 4-dimension evaluation rubric
├── prompts/
│   ├── 01-twosidednews.md          # 16 original prompts
│   ├── ...
│   ├── 17-retroforge.md            # Anthropic comparison
│   ├── 18-browser-daw.md           # Anthropic comparison
│   ├── 19-dutch-art-museum.md      # Anthropic comparison
│   └── 20-design-desk.md           # OpenAI comparison
├── schema/
│   └── agent-result.schema.json    # Publishable output schema
├── calibration/                     # Hand-scored example projects (post Phase 1)
│   └── README.md
├── src/
│   ├── orchestrator.ts
│   ├── container-manager.ts
│   ├── key-distributor.ts
│   ├── prompt-loader.ts
│   ├── types.ts
│   ├── config.ts
│   ├── judge/
│   │   ├── judge-runner.ts
│   │   ├── state-reader.ts
│   │   ├── drift-evaluator.ts
│   │   ├── telegram-notifier.ts
│   │   └── kill-handler.ts
│   ├── eval/
│   │   ├── smoke-runner.ts
│   │   ├── llm-judge.ts
│   │   └── calibration.ts
│   └── analysis/
│       ├── aggregator.ts
│       ├── baseline-compare.ts
│       ├── sanitizer.ts
│       └── report.ts
├── tests/
│   ├── prompt-loader.test.ts       # Unit: YAML parsing
│   ├── key-distributor.test.ts     # Unit: round-robin + validation
│   ├── agent-id.test.ts            # Unit: ID format
│   ├── drift-evaluator.test.ts     # Unit: stage detection
│   ├── smoke-runner.test.ts        # Unit: expect clause evaluation
│   ├── calibration.test.ts         # Unit: agreement calculation
│   ├── sanitizer.test.ts           # Unit: secret pattern stripping
│   ├── container-lifecycle.test.ts # Integration: start/stop container
│   └── confidence.test.ts          # E2E: 2-agent confidence test
├── results/                         # Output directory (gitignored)
│   └── publishable/                # Sanitized, schema-validated outputs
└── package.json
```

---

## Execution Order

```
Phase 1 (scaffold)     → Phase 2 (orchestrator)  → Phase 3 (judge)
     │                        │                         │
     │  static assets         │  container lifecycle    │  monitoring
     │  prompts, schemas      │  key distribution       │  drift detection
     │  Dockerfile            │  prompt loading         │  Telegram
     ▼                        ▼                         ▼
                    Phase 4 (evaluation)
                         │
                         │  smoke tests
                         │  LLM judge + calibration
                         ▼
                    Phase 5 (analysis)
                         │
                         │  aggregation
                         │  baselines
                         │  sanitization
                         ▼
                    Phase 6 (verification)
                         │
                         │  confidence test (2 agents)
                         │  hostile QA (5 agents)
                         │  Phase 1 go/no-go
                         ▼
                    PHASE 1 RUN (40 agents)
                         │
                         │  hand-score calibration set
                         │  validate methodology
                         ▼
                    PHASE 2 RUN (200 agents)
```

Each phase is self-contained and can be executed in a fresh Claude Code session.
