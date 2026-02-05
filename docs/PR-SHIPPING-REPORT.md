# Claude-Mem PR Shipping Report
*Generated: 2026-02-04*

## Executive Summary

6 PRs analyzed for shipping readiness. **1 is ready to merge**, 4 have conflicts, 1 is too large for easy review.

| PR | Title | Status | Recommendation |
|----|-------|--------|----------------|
| **#856** | Idle timeout for zombie processes | ✅ **MERGEABLE** | **Ship it** |
| #700 | Windows Terminal popup fix | ⚠️ Conflicts | Rebase, then ship |
| #722 | In-process worker architecture | ⚠️ Conflicts | Rebase, high impact |
| #657 | generate/clean CLI commands | ⚠️ Conflicts | Rebase, then ship |
| #863 | Ragtime email investigation | 🔍 Needs review | Research pending |
| #464 | Sleep Agent Pipeline (contributor) | 🔴 Too large | Request split or dedicated review |

---

## Ready to Ship

### PR #856: Idle Timeout for Zombie Observer Processes
**Status:** ✅ MERGEABLE (no conflicts)

| Metric | Value |
|--------|-------|
| Additions | 928 |
| Deletions | 171 |
| Files | 8 |
| Risk | Low-Medium |

**What it does:**
- Adds 3-minute idle timeout to `SessionQueueProcessor`
- Prevents zombie observer processes that were causing 13.4GB swap usage
- Processes exit gracefully after inactivity instead of waiting forever

**Why ship it:**
- Fixes real user-reported issue (79 zombie processes)
- Well-tested (11 new tests, 440 lines of test coverage)
- Clean implementation, preventive approach
- Supersedes PR #848's reactive cleanup
- No conflicts, ready to merge

**Review notes:**
- 1 Greptile bot comment (addressed)
- Race condition fix included
- Enhanced logging added

---

## Needs Rebase (Have Conflicts)

### PR #700: Windows Terminal Popup Fix
**Status:** ⚠️ CONFLICTING

| Metric | Value |
|--------|-------|
| Additions | 187 |
| Deletions | 399 |
| Files | 8 |
| Risk | Medium |

**What it does:**
- Eliminates Windows Terminal popup by removing spawn-based daemon
- Worker `start` command becomes daemon directly (no child spawn)
- Removes `restart` command (users do `stop` then `start`)
- Net simplification: -212 lines

**Breaking changes:**
- `restart` command removed

**Review status:**
- ✅ 1 APPROVAL from @volkanfirat (Jan 15, 2026)

**Action needed:** Resolve conflicts, then ready to ship.

---

### PR #722: In-Process Worker Architecture
**Status:** ⚠️ CONFLICTING

| Metric | Value |
|--------|-------|
| Additions | 869 |
| Deletions | 4,658 |
| Files | 112 |
| Risk | High |

**What it does:**
- Hook processes become the worker (no separate daemon spawning)
- First hook that needs worker becomes the worker
- Eliminates Windows spawn issues ("NO SPAWN" rule)
- 761 tests pass

**Architectural impact:** HIGH
- Fundamentally changes worker lifecycle
- Hook processes stay alive (they ARE the worker)
- First hook wins port 37777, others use HTTP

**Action needed:** Resolve conflicts. Consider relationship with PR #700 (both touch worker architecture).

---

### PR #657: Generate/Clean CLI Commands
**Status:** ⚠️ CONFLICTING

| Metric | Value |
|--------|-------|
| Additions | 1,184 |
| Deletions | 5,057 |
| Files | 104 |
| Risk | Medium |

**What it does:**
- Adds `claude-mem generate` and `claude-mem clean` CLI commands
- Fixes validation bugs (deleted folders recreated from stale DB)
- Fixes Windows path handling
- Adds automatic shell alias installation
- Disables subdirectory CLAUDE.md files by default

**Breaking changes:**
- Default behavior change: folder CLAUDE.md now disabled by default

**Action needed:** Resolve conflicts, complete Windows testing.

---

## Needs Attention

### PR #863: Ragtime Email Investigation
**Status:** 🔍 Research pending

Research agent did not return results. Manual review needed.

---

### PR #464: Sleep Agent Pipeline (Contributor: @laihenyi)
**Status:** 🔴 Too large for effective review

| Metric | Value |
|--------|-------|
| Additions | 15,430 |
| Deletions | 469 |
| Files | 73 |
| Wait time | 37+ days |
| Risk | High |

**What it does:**
- Sleep Agent Pipeline with memory tiering
- Supersession detection
- Session Statistics API (`/api/session/:id/stats`)
- StatusLine + PreCompact hooks
- Context Generator improvements
- Self-healing CI workflow

**Concerns:**
| Issue | Details |
|-------|---------|
| 🔴 Size | 15K+ lines is too large for effective review |
| 🔴 SupersessionDetector | Single file with 1,282 additions |
| 🟡 No tests visible | Test plan checkboxes unchecked |
| 🟡 Self-healing CI | Auto-fix workflow could cause infinite commit loops |
| 🟡 Serena config | Adds `.serena/` tooling |

**Recommendation:**
1. **Option A:** Request contributor split into 4-5 smaller PRs
2. **Option B:** Allocate dedicated review time (several hours)
3. **Option C:** Cherry-pick specific features (hooks, stats API)

**Note:** Contributor has been waiting 37+ days. Deserves response either way.

---

## Shipping Strategy

### Phase 1: Quick Wins (This Week)
1. **Merge #856** — Ready now, fixes real user issue
2. **Rebase #700** — Has approval, Windows fix needed
3. **Rebase #657** — Useful CLI commands

### Phase 2: Architecture (Careful Review)
4. **Review #722** — High impact, conflicts with #700 approach?
   - Both PRs eliminate spawning but in different ways
   - May need to pick one approach

### Phase 3: Contributor PR
5. **Respond to #464** — Options:
   - Ask for split
   - Schedule dedicated review
   - Cherry-pick subset

### Phase 4: Investigation
6. **Manual review #863** — Ragtime email feature

---

## Conflict Resolution Order

Since multiple PRs have conflicts, suggested rebase order:

1. **#856** (merge first — no conflicts)
2. **#700** (rebase onto main after #856)
3. **#657** (rebase onto main after #700)
4. **#722** (rebase last — may conflict with #700 architecturally)

---

## Summary

| Ready | Conflicts | Needs Work |
|-------|-----------|------------|
| 1 PR (#856) | 3 PRs (#700, #722, #657) | 2 PRs (#464, #863) |

**Immediate action:** Merge #856, then rebase the conflict PRs in order.
