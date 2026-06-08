# Execution Plan — claude-mem plan-master backlog (recluster 2026-06-04)

Cross-cluster sequencing for the 9 open plan masters (#2778–#2786). Per-cluster
phase detail lives in `plans/0X-*.md`. This file is the *order*, the *dependencies*,
and the *ship contract*.

## Ship contract (per cluster, Mode 3)

1. One PR per master. PR title = the architectural fix. PR body ends with `Closes #<master>`.
2. The cluster's test matrix (from its `plans/0X` doc) lands in CI **in the same PR** — no matrix, no merge.
3. A master closes only when every listed child symptom is covered by the merged PR(s).
   plan-12 is the exception: it closes when its independent slices have all shipped.

## Dependency graph

```
plan-10 (build/deps)  ──blocks──▶  everything (runtime won't boot without the dep closure)

plan-01 (hook IO) ──┐
                    ├──▶ plan-03 (#2703 Windows 0-obs) ──▶ plan-04 (install detection)
plan-02 (spawn)  ──┘

plan-09 (data)    ─┐
plan-11 (observer) ├── independent of the Windows chain; can run fully in parallel
plan-13 (grammar) ─┘

plan-12 (roadmap) ── opportunistic; never blocks a defect cluster
```

## Release waves

### Wave 0 — Unblock (ship first, smallest)
- **plan-10 #2783** — `zod/v3` missing from the shipped dependency closure crashes the
  worker/Stop hook on every auto-update (Linux). Nothing downstream runs reliably until
  this is fixed. Tiny PR + clean-room install smoke test in CI.
  - ⚠️ **Doc is thin — expand to phases before assigning.**

### Wave 1 — Windows spawn/IO foundation (largest symptom family)
- **plan-01 #2778** — Hook IO Discipline. Land first within the wave; plan-02's hook
  command emit depends on the typed IO wrapper. *(full plan ready)*
- **plan-02 #2779** — Spawn-Contract Templating. Retires the cmd.exe/uvx/PATH/encoding
  family once 01's emit discipline is in place. *(full plan ready)*

### Wave 2 — Worker reliability (needs Wave 1 for the Windows path)
- **plan-03 #2780** — Worker/Daemon Lifecycle. PID identity, supervision, OOM + transcript
  bounds. Its child **#2703 (0 observations on Windows)** only fully resolves after 01+02
  ship, so sequence it after Wave 1. *(full plan ready)*

### Wave 3 — Platform-agnostic correctness (parallel with Waves 1–2, different owner)
- **plan-09 #2782** — Data-Pipeline Integrity (session-id stamping, EXCLUDED_PROJECTS in
  Stop, FTS5 `type` column, worker-runtime write tools). ⚠️ **Thin doc — expand.**
- **plan-11 #2784** — Observer Output Fidelity (poison classification + recovery, truncation
  protection). ⚠️ **Thin doc — expand.**
- **plan-13 #2786** — Grammar/Parser Fidelity (plain-JS query split, custom-grammar load).
  ⚠️ **Thin doc — expand.**

### Wave 4 — Install UX (after 01/02/10 are stable)
- **plan-04 #2781** — Installer Transparency. Host/IDE detection must route correctly, which
  presumes the spawn + dep fixes have landed. *(full plan ready)*

### Wave 5 — Roadmap (ongoing, non-blocking)
- **plan-12 #2785** — 14 net-new slices. Each slice gets its own `/make-plan` and ships
  opportunistically. Master stays open until the sub-areas land.

## Consolidated CI matrix (the regression backstop)

Each cluster contributes its axes; together they form the suite that must stay green:

| Source | Axis | Cells |
|---|---|---|
| plan-01 | host × shell × locale | Windows PS7 / git-bash / GBK / Codex |
| plan-02 | host × spawn surface | cmd.exe uvx pins, mcp-search, chroma-mcp, no-window |
| plan-03 | lifecycle scenario | start PID, recycled PID, long-gen, host-dev OOM, transcript rotate |
| plan-04 | host × install method | npm-g vs Desktop discrimination (12×4) |
| plan-09 | write/read path | id-stamp parity, exclusion, `type:` search, runtime write |
| plan-10 | publish | clean-room install: full runtime dep closure present |
| plan-11 | observer output | idle / prose / truncation / missing-results recovery |
| plan-13 | language | js/mjs/cjs, ts/tsx, custom grammar |

## Readiness summary

| Master | Cluster | Plan depth | Blocked by | Wave |
|---|---|---|---|---|
| #2783 | plan-10 build/deps | ⚠️ thin | — | 0 |
| #2778 | plan-01 hook IO | ✅ full | #2783 | 1 |
| #2779 | plan-02 spawn | ✅ full | #2778 | 1 |
| #2780 | plan-03 worker | ✅ full | #2778, #2779 | 2 |
| #2782 | plan-09 data | ⚠️ thin | — | 3 |
| #2784 | plan-11 observer | ⚠️ thin | — | 3 |
| #2786 | plan-13 grammar | ⚠️ thin | — | 3 |
| #2781 | plan-04 install | ✅ full | #2778, #2779, #2783 | 4 |
| #2785 | plan-12 roadmap | n/a (roadmap) | — | 5 |

## Outstanding work before this plan is fully executable

1. **Expand 4 thin docs to phase-level** (plan-09, plan-10, plan-11, plan-13) — same Phase 0→N
   structure as plan-01..04, each with its own CI matrix cells.
2. **Decompose plan-12** into per-slice `/make-plan` prompts (14 slices).
3. Then each master is assignable as a single forcing PR per the ship contract above.
