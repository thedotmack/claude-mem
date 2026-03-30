# 200-Agent Benchmark: claude-mem vs Vanilla Claude Code

## Overview

200-agent Docker benchmark comparing claude-mem vs vanilla Claude Code with auto memory. 100 agents per arm, 20 project prompts (5 agents of each type per prompt to measure drift). Agents autonomously orchestrate an entire project from plan to MVP delivery. Measures token usage, quality, speed, and drift over long-term project development.

**Mode:** HOLD SCOPE (CEO review approved, no expansions)
**Approach:** Phased (Phase 1: 20 agents, Phase 2: 200 agents)
**Branch:** `thedotmack/200-agents-test`

---

## Key Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Approach | Phased (20 → 200) | Validate methodology before burning budget |
| 2 | Completion signal | Self-declared DONE.md | Most realistic |
| 3 | Safety valve | 10-min judge cycles, stage-aware | Catches drift early, cheap |
| 4 | Quality measurement | LLM-as-judge + human spot-check | Coverage + calibration |
| 5 | API keys | Round-robin pool, any count | Simple, scales |
| 6 | Internet access | Full access | Realistic dev environment |
| 7 | Judge blinding | Yes, strip agent type before eval | Eliminates scoring bias |
| 8 | Token tracking | Transcript JSONL (same format both arms) | Apples-to-apples |
| 9 | Project prompts | 20 across 5 categories from Devpost | Good variety, all testable |
| 10 | Drift definition | Per-agent plan conformance (not statistical variance) | Judge evaluates scope adherence |

---

## Architecture

```
BENCHMARK ARCHITECTURE
═══════════════════════════════════════════════════════════════

  ┌─────────────────────────────────────────────────────────┐
  │                    ORCHESTRATOR HOST                     │
  │                                                         │
  │  ┌──────────┐  ┌──────────┐  ┌────────────────────┐   │
  │  │ Prompt   │  │ Docker   │  │ Results Aggregator  │   │
  │  │ Distrib  │  │ Compose  │  │ + Dashboard         │   │
  │  └────┬─────┘  └────┬─────┘  └────────┬───────────┘   │
  │       │              │                  │               │
  │  ┌────┴──────────────┴──────────────────┴───────────┐  │
  │  │              JUDGE AGENT (every 10 min)           │  │
  │  │  Evaluates progress, drift, kills runaways        │  │
  │  └───────────────────┬──────────────────────────────┘  │
  └──────────────────────┼─────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
  ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
  │ Agent 1   │   │ Agent 2   │   │ Agent N   │  ... x200
  │           │   │           │   │           │
  │ claude-mem│   │ vanilla   │   │ claude-mem│
  │ + CC      │   │ CC only   │   │ + CC      │
  │           │   │           │   │           │
  │ /workspace│   │ /workspace│   │ /workspace│
  │ (git repo)│   │ (git repo)│   │ (git repo)│
  └───────────┘   └───────────┘   └───────────┘
       │                │                │
       ▼                ▼                ▼
  ┌─────────┐    ┌─────────┐    ┌─────────┐
  │ Results  │    │ Results  │    │ Results  │
  │ Volume   │    │ Volume   │    │ Volume   │
  │ (shared) │    │ (shared) │    │ (shared) │
  └─────────┘    └─────────┘    └─────────┘
```

### API Key Distribution

```
ORCHESTRATOR
  │
  ├── API Key Pool (keys.env: KEY_1, KEY_2, ... KEY_N)
  │     └── Round-robin assignment: agent_id % num_keys
  │
  ├── Agent containers (each gets one key via env var)
  │
  └── Judge agent (uses its own dedicated key, not from the pool)
```

### Dependency Graph

```
  Prompt files ──▶ Orchestrator ──▶ Docker containers
                        │
                        ├──▶ Judge agent (reads container state)
                        │
                        └──▶ Results aggregator (reads volumes post-completion)
                                    │
                                    └──▶ LLM-as-judge evaluator
```

### Key Architectural Decisions

1. **Each container is fully isolated.** Own git repo, own filesystem, own Claude Code session. Claude-mem containers also get their own `~/.claude-mem/` directory with SQLite + Chroma.
2. **Shared results volume** for each container to write metrics (token counts, timestamps, DONE.md, git log).
3. **Judge agent runs on the host**, not inside containers. It reads container state via Docker exec or mounted volumes.
4. **API key round-robin.** All containers share a pool of Anthropic API keys. Round-robin assignment: `agent_id % num_keys`. Judge gets its own dedicated key.

---

## File Structure

```
benchmark/
├── Dockerfile.claude-mem      # Container with claude-mem installed
├── Dockerfile.vanilla         # Container with vanilla CC + auto memory
├── docker-compose.yml         # Orchestration (or a shell script)
├── prompts/                   # 20 project prompt files
│   ├── 01-todo-app.md
│   ├── 02-chat-app.md
│   └── ...
├── scripts/
│   ├── orchestrate.sh         # Launch agents, distribute prompts + keys
│   ├── judge.sh               # 10-minute judge evaluation
│   ├── collect-results.sh     # Post-run aggregation
│   └── evaluate.sh            # LLM-as-judge scoring
├── keys.env                   # API keys (gitignored)
├── results/                   # Output directory (gitignored)
└── analysis/
    └── compare.py             # Token/quality/speed comparison
```

**Naming convention:** Each agent gets an ID: `{type}-{prompt_id}-{replica}`, e.g., `cmem-03-2` (claude-mem, prompt 3, replica 2) or `vanilla-03-2`.

**DRY:** Single Dockerfile with a build arg (`--build-arg MEMORY_TYPE=claude-mem|vanilla`) that conditionally runs the claude-mem install step.

---

## Error & Rescue Map

```
METHOD/CODEPATH              | WHAT CAN GO WRONG              | EXCEPTION CLASS
-----------------------------|--------------------------------|------------------
Container startup            | Docker daemon not running       | DockerError
                             | Image build fails               | BuildError
                             | Port conflict                   | PortConflict
                             | Out of disk space               | DiskFull
Claude Code install (in-ctr) | npx times out                  | InstallTimeout
                             | npm registry unreachable        | NetworkError
                             | Node.js version mismatch        | VersionError
claude-mem install (in-ctr)  | npx claude-mem install fails    | InstallError
                             | Worker service won't start      | WorkerStartError
                             | Bun not found                   | DependencyError
Agent autonomous session     | API key invalid/expired         | AuthError
                             | Rate limited (429)              | RateLimitError
                             | Model overloaded (529)          | OverloadError
                             | Agent enters infinite loop      | (no exception)
                             | Agent crashes mid-build         | ProcessExit
                             | Agent declares done prematurely | (semantic error)
                             | Context window exceeded         | ContextOverflow
Judge agent (10-min cycles)  | Can't read container state      | AccessError
                             | Judge itself gets rate limited   | RateLimitError
                             | Judge misclassifies drift       | (semantic error)
                             | Judge kills healthy agent        | FalsePositive
Results collection           | Container died before writing   | MissingResults
                             | SQLite DB corrupted             | DBCorruption
                             | Partial results (mid-build)     | IncompleteData
LLM-as-judge evaluation      | Judge hallucinates scores       | (semantic error)
                             | Inconsistent rubric application | (semantic error)
                             | Can't access project files      | AccessError
```

### Rescue Map

```
EXCEPTION CLASS           | RESCUED? | RESCUE ACTION              | USER SEES
--------------------------|----------|----------------------------|------------------
DockerError               | Y        | Pre-flight check, fail fast | "Docker not running"
BuildError                | Y        | Retry once, then abort      | Build log + error
InstallTimeout            | Y        | Retry with longer timeout   | Retry count
NetworkError              | Y        | Retry 3x with backoff       | "npm unreachable"
WorkerStartError          | Y        | Log + mark agent as FAILED  | Agent status: FAILED
AuthError                 | Y        | Pre-flight key validation   | "Invalid key: KEY_N"
RateLimitError            | Y*       | CC has built-in retry       | Inflated timing
OverloadError             | Y*       | CC has built-in retry       | Inflated timing
ProcessExit               | Y        | Health check writes CRASHED.md | Agent status: CRASHED
ContextOverflow           | Y*       | CC handles internally       | Session may restart
MissingResults            | Y        | Mark as INCOMPLETE          | INCOMPLETE in analysis
FalsePositive (judge)     | Partial  | Judge writes reasoning log  | Post-hoc review
```

---

## Security

1. **API key exposure.** Keys injected at runtime via Docker secrets or `.env` file, never baked into images. `.env` is `.gitignored`.
2. **Cost runaway.** Hard wall-clock timeout on Docker containers (e.g., 8 hours) as backstop behind judge agent.
3. **Agent-generated code.** Docker isolation handles arbitrary code execution. Containers have no network access to host or other containers except Anthropic API.

---

## Data Flow

```
PROMPT FILE ──▶ ORCHESTRATOR ──▶ CONTAINER ENV ──▶ CLAUDE CODE SESSION
    │                │                │                    │
    ▼                ▼                ▼                    ▼
 [missing?]    [malformed?]    [key invalid?]       [agent stuck?]
 [encoding?]   [dup assign?]   [disk full?]         [declares done
 [too long?]                                         prematurely?]
                                                     [crashes?]
                                                          │
                                                          ▼
                                              RESULTS VOLUME
                                                   │
                                                   ▼
                                            [missing files?]
                                            [partial write?]
                                            [corrupted DB?]
                                                   │
                                                   ▼
                                            AGGREGATOR ──▶ LLM JUDGE
                                                              │
                                                              ▼
                                                        [hallucinated
                                                         scores?]
                                                        [inconsistent
                                                         rubric?]
```

**Internet access:** Full. Agents can npm install, pip install, fetch docs, hit APIs. Variability is part of what's being tested.

---

## Judge Agent Design

**Stage-aware drift detection:**

- **Planning phase**: Does a coherent plan exist? Is it scoped to the prompt?
- **Scaffolding phase**: Are the right files/structure being created? Does the plan match the prompt?
- **Building phase**: Is it implementing what the plan says? Are core features taking shape?
- **Integration phase**: Does it run? Does it do what the prompt asked?
- **Polish phase**: Does it handle edge cases? Tests passing?

The agent's own plan (created at start) becomes the baseline. The judge reads the plan, checks current state against where the agent should be given elapsed time, and scores drift severity: on-track / minor deviation / major drift / unrecoverable.

**Blinding:** Agent type identifiers stripped from project directories before judge evaluation.

---

## Token Measurement

Both arms produce transcript JSONL files with identical `UsageInfo` schema (from Claude API response). `TranscriptParser.getTotalTokenUsage()` sums `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`.

- **Vanilla total tokens** = transcript token usage
- **claude-mem total tokens** = transcript token usage + observer agent token usage
- **claude-mem net value** = quality delta / (token overhead from observer)

The observer overhead is measurable separately from `discovery_tokens` tracked per observation in the SQLite DB.

---

## Test Strategy (Phase 1 Harness)

| What | Test | Type |
|------|------|------|
| Container builds | `docker build` both variants, verify CC runs | Smoke |
| claude-mem installs correctly | Container starts, `curl localhost:37777/health` returns OK | Integration |
| Key distribution | 4 keys, 10 agents → verify round-robin assignment | Unit (script) |
| Agent ID naming | Verify `{type}-{prompt}-{replica}` format | Unit |
| Judge reads container state | Mock container with known state, verify judge output | Integration |
| Results collection handles missing data | Kill container mid-run, verify INCOMPLETE status | Chaos |
| LLM judge scoring consistency | Run judge on same project twice, compare scores | Calibration |
| Pre-flight key validation | Pass invalid key, verify it's caught before launch | Unit |

**Confidence test:** Run 2 agents (1 cmem, 1 vanilla) with the simplest prompt. Both complete. Results collected. LLM judge scores both. Comparison shows valid data.

**Hostile QA test:** Launch 5 agents, kill 2 mid-run, let 1 hit rate limit. Verify: 2 CRASHED, 1 delayed but complete, 2 normal. Aggregation handles all 5 states.

---

## Performance Sizing

**Phase 1 (20 agents):**
- RAM: 20 × ~1GB = ~20GB. 32GB instance handles this.
- CPU: 8-16 cores (agents mostly wait on API calls).
- Disk: 50GB total.

**Phase 2 (200 agents):**
- RAM: ~200GB. Large instance or multiple hosts.
- Docker overhead at 200 containers is non-trivial. May need k8s or multiple Docker hosts.

**Slow paths:**
1. LLM-as-judge evaluation of 200 projects (parallelize).
2. Container image build (build once, reuse).
3. claude-mem Chroma indexing (local per container, no shared bottleneck).

---

## Observability

1. **Agent status dashboard.** For each agent: running/done/crashed/killed-by-judge. Simple `docker ps` + `ls results/*/DONE.md` loop.
2. **Token counter per agent.** Both arms: parse transcript JSONL.
3. **Judge decision log.** Every 10-min evaluation writes to `results/{agent_id}/judge-log.jsonl`.
4. **Cost estimate.** Running total: sum of all agent tokens × price per token.
5. **Post-mortem reconstruction.** For claude-mem agents: timeline API, observation DB, search. For vanilla: Claude Code session logs.

---

## 20 Project Prompts

**WEB APPS (6)**

| # | Project | Testable Deliverable |
|---|---------|---------------------|
| 1 | TwoSidedNews | Serves on port 3000, enter topic, see two columns of opposing articles |
| 2 | MealPrep Planner | Create account, save meal plan, export grocery list |
| 3 | Study Boss Fight | Create deck, start battle, track score, boss health depletes |
| 4 | Job Hunt Dashboard | CRUD for applications, filter by status, calendar view |
| 5 | Shame Board | Upload image, see generated text, shareable link works |
| 6 | Password Vault | Create vault, add/edit/delete entries, search, encrypted storage |

**CLI TOOLS (4)**

| # | Project | Testable Deliverable |
|---|---------|---------------------|
| 7 | Slack Summarizer | `summarize --input export.json` outputs markdown summaries |
| 8 | Git Repo Analyzer | `analyze /path/to/repo` outputs structured report |
| 9 | Markdown Site Generator | `generate ./docs --output ./site` produces working HTML |
| 10 | CSV Data Explorer | `explore data.csv` launches interactive TUI |

**APIs / BACKEND (4)**

| # | Project | Testable Deliverable |
|---|---------|---------------------|
| 11 | URL Shortener | POST /shorten, GET /:alias redirects, GET /stats/:alias returns counts |
| 12 | Recipe API | All CRUD endpoints work, search returns relevant results |
| 13 | Real-time Chat Server | Connect via WS, join room, send/receive messages, history persists |
| 14 | Expense Tracker API | Register/login, CRUD expenses, GET /summary returns aggregates |

**DATA / ANALYSIS (3)**

| # | Project | Testable Deliverable |
|---|---------|---------------------|
| 15 | Sentiment Dashboard | Upload CSV, see sentiment scores, filter by rating/date |
| 16 | Log Analyzer | `analyze access.log` produces report with charts |
| 17 | Text Similarity Finder | Upload docs, see similarity matrix, click pair to compare |

**FULL-STACK (3)**

| # | Project | Testable Deliverable |
|---|---------|---------------------|
| 18 | Kanban Board | Create board, add/move cards between columns, data persists on refresh |
| 19 | Pomodoro + Task Tracker | Create task, start timer, complete pomodoro, see stats |
| 20 | Link-in-Bio Page Builder | Create page, add links, choose theme, view at /username |

---

## NOT in scope

- Continuous benchmark CI (run on every release)
- Public leaderboard
- Community-submitted prompts
- Kubernetes orchestration (Phase 2 concern)
- Automated report generation
- Comparison against non-Claude agents (Cursor, Copilot, etc.)

## What already exists

- claude-mem installer (`npx claude-mem install`)
- Worker service + SQLite DB + Chroma (full observability for cmem agents)
- Claude Code's built-in auto memory (MEMORY.md)
- Claude Code's transcript/usage reporting (TranscriptParser)
- Docker ecosystem for container isolation

---

## Codex Outside Voice Findings (22 total, 2 accepted)

**Accepted:**
1. **Judge blinding** — strip agent type identifiers before evaluation
2. **Token measurement** — both arms use transcript JSONL (apples-to-apples)

**Noted but not actioned (academic experiment design concerns):**
- No causal isolation (changing multiple variables)
- Effective sample size clustering by prompt
- No pre-registered primary endpoint
- No multiplicity control
- DONE.md gaming potential
- Hourly judge as uncontrolled treatment effect
- "Unrecoverable" undefined
- No hard time cap
- LLM-as-judge model-family bias
- Rubric-only scoring without executable tests
- API key round-robin as confounder
- No model/version pinning
- Full internet = non-stationary environment
- Resource contention across containers
- Shared caches/volumes leakage
- 20 prompts is small and unstratified
- Phase 1→2 no go/no-go criterion
- Failure taxonomy missing
- Human spot-check undefined

---

## Failure Modes Registry

```
CODEPATH              | FAILURE MODE          | RESCUED? | TEST? | USER SEES     | LOGGED?
----------------------|-----------------------|----------|-------|---------------|--------
Container startup     | Docker not running    | Y        | Y     | Error msg     | Y
Container startup     | Disk full             | Y        | N     | Pre-flight    | Y
API key validation    | Invalid key           | Y        | Y     | Pre-flight    | Y
Agent session         | Infinite loop         | Y        | Y     | Judge kills   | Y
Agent session         | Crash mid-build       | Y        | Y     | CRASHED.md    | Y
Judge agent           | Misclassifies drift   | Partial  | N     | Healthy kill  | Y (log)
Results collection    | Missing files         | Y        | Y     | INCOMPLETE    | Y
LLM judge             | Inconsistent scoring  | Partial  | N     | Bad data      | Calibration run
```

---

## Eng Review Decisions (2026-03-29)

| # | Issue | Decision | Rationale |
|---|-------|----------|-----------|
| 1 | Custom Dockerfiles | Use Anthropic's official devcontainer as base | Layer 1, less custom infra to maintain |
| 2 | Resource limits | Deferred to Phase 2 | Need Phase 1 data to set meaningful limits |
| 3 | Judge SPOF | Add heartbeat file + orchestrator check | 10 lines of bash prevents silent money burn |
| 4 | Hard time cap | Per-prompt timeout in YAML frontmatter | Uniform timeout doesn't fit varying project complexity |
| 5 | Model pinning | Pin exact model version via ANTHROPIC_MODEL env var | Zero cost, eliminates version drift confounder |
| 6 | Prompt config | YAML frontmatter in each prompt file | Co-locate config with content, DRY |
| 7 | Implementation language | TypeScript (single orchestrator, not shell scripts) | Matches existing stack, cleaner for API calls |
| 8 | Test scope | 7 unit tests + 2 E2E tests | Unit tests are free, E2E validates end-to-end |
| 9 | Judge eval parallelism | Sequential for Phase 1 | YAGNI, optimize if actually slow |

## CEO Review Status

- **Status:** CLEAN (HOLD SCOPE)
- **Critical gaps:** 2 (resolved: disk-full detection, judge scoring consistency)
- **Scope proposals:** 0 (HOLD SCOPE active)
- **Outside voice:** Codex, 22 findings, 2 accepted
- **Commit:** d0688212

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | HOLD_SCOPE, 2 critical gaps (resolved) |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | ISSUES_FOUND | 22 findings, 2 accepted |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 9 issues, 1 critical gap |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

- **UNRESOLVED:** 0 decisions across all reviews
- **VERDICT:** CEO + ENG CLEARED — ready to implement
