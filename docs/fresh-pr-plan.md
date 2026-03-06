# Fresh PR Development Plan - Titans/Sleep Agent Features

> **Status**: Planning
> **Created**: 2026-02-16
> **Context**: PR #464 closed by maintainer - recommend fresh PR against current main

## Background

PR #464 was closed on 2026-02-16 by thedotmack with the following rationale:
- Diverged too significantly from main (+17,929 lines, 79 files)
- 4+ months stale
- Codebase has undergone major changes

**Recommendation**: Create a fresh PR against current main.

## Strategy: Incremental Feature Integration

Rather than one massive PR, we'll create a series of smaller, focused PRs:

### Phase 1: Foundation (Week 1-2)

**PR #1: Database Schema & Migrations**
- [ ] Extract migrations 008-012 from feature branch
- [ ] Verify compatibility with current SessionStore
- [ ] Add only: `importance_score`, `surprise_score`, `memory_tier`, `reference_count`
- [ ] Test: `bun test tests/sqlite/`

**Scope**: ~200-300 lines, low risk

---

**PR #2: Access Tracking Infrastructure**
- [ ] Port `AccessTracker.ts` (simplified)
- [ ] Add `memory_access` table
- [ ] API: `GET /api/memory/:id/stats`, `POST /api/memory/:id/access`
- [ ] Test: Basic access recording

**Scope**: ~150-200 lines, low risk

---

### Phase 2: Core Intelligence (Week 3-4)

**PR #3: Importance Scoring**
- [ ] Port `ImportanceScorer.ts`
- [ ] Port `SemanticRarity.ts` (if Chroma integration stable)
- [ ] API: `GET /api/memory/rare`, `GET /api/memory/low-importance`
- [ ] Test: Score calculation accuracy

**Scope**: ~400-500 lines, medium risk

---

**PR #4: Surprise Metric System**
- [ ] Port `SurpriseMetric.ts` (with layered fallback)
- [ ] Port `MomentumBuffer.ts`
- [ ] API: `GET /api/surprise/:id`, `GET /api/surprising`
- [ ] Test: Surprise calculation, momentum boost

**Scope**: ~600-800 lines, medium risk

---

### Phase 3: Lifecycle & UX (Week 5-6)

**PR #5: StatusLine Hook**
- [ ] Port `statusline-hook.ts`
- [ ] API: `GET /api/stats?project=X` with savings calculation
- [ ] Ensure worker restart resilience
- [ ] Test: Hook displays correct metrics

**Scope**: ~200-300 lines, low risk

---

**PR #6: Session Statistics API**
- [ ] Port session stats endpoints
- [ ] API: `GET /api/session/:id/stats`
- [ ] Integrate with StatusLine
- [ ] Test: Per-session metrics accuracy

**Scope**: ~150-200 lines, low risk

---

### Phase 4: Advanced Features (Week 7+)

**PR #7: Pipeline Architecture (Optional)**
- [ ] Port 5-stage pipeline if needed
- [ ] Checkpoint/resume capability
- [ ] Metrics tracking

**Scope**: ~800-1000 lines, high complexity

---

**PR #8: Sleep Agent (Future)**
- [ ] Port `SleepAgent.ts`
- [ ] Port `SupersessionDetector.ts`
- [ ] Port `LearnedSupersessionModel.ts`
- [ ] Memory tier management

**Scope**: ~2000+ lines, highest complexity

---

## What to NOT Port (Deprecated)

1. **Standalone hook scripts** - Main now uses bundled architecture
2. **Old build outputs** - Rebuild from source
3. **Outdated SDKAgent changes** - Main has refactored agent system
4. **Migration 011 training tables** - Complex ML, defer until needed

## Technical Debt to Address

From current open issues (must fix before new features):
- #1124: Hooks race condition
- #1123: Chroma auto-recovery
- #1091: PostToolUse 500 errors
- #1104: Windows ONNX resolution

## Success Criteria

Each PR should:
1. ✅ Pass all existing tests
2. ✅ Add new tests for new functionality
3. ✅ Update documentation
4. ✅ Be < 1000 lines (ideally < 500)
5. ✅ Have clear scope and test plan

## Timeline

| Phase | Duration | Risk Level |
|-------|----------|------------|
| Phase 1 (Foundation) | 2 weeks | Low |
| Phase 2 (Core Intel) | 2 weeks | Medium |
| Phase 3 (Lifecycle) | 2 weeks | Low |
| Phase 4 (Advanced) | 3+ weeks | High |

**Total**: 7-10 weeks for full feature set

## Next Actions

1. [ ] Create `feature/titans-foundation` branch from `origin/main`
2. [ ] Extract migration schema changes
3. [ ] Port AccessTracker with current main compatibility
4. [ ] Submit PR #1 (Database Schema)

---

## Reference

- Original PR: https://github.com/thedotmack/claude-mem/pull/464
- Feature branch: `feature/titans-with-pipeline`
- Main version: v10.0.7+
