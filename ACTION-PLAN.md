# Action Plan: Issues & PRs Cleanup
Generated: 2025-12-12

## Phase 1: Immediate Cleanup (Today)

### Close Obsolete PRs

- [ ] **#255** - Close PR "Fix PM2 worker MODULE_NOT_FOUND"
  - Reason: v7.1.0 removed PM2 entirely, this fix is no longer relevant
  - Comment: Explain that v7.1.0 migration to Bun eliminated PM2 dependency

- [ ] **#206** - Close or request update on "Harden worker startup"
  - Reason: Contains PM2-specific code that no longer exists
  - Comment: Ask author if they want to update for Bun architecture, otherwise close as obsolete

### Close/Update Fixed Issues

- [ ] **#213** - Comment and close "Windows endless process spawning"
  - Reason: v7.1.0 Bun migration eliminated PM2 process management
  - Comment: Ask user to verify fix on v7.1.0, explain PM2 removal resolved issue

- [ ] **#229** - Close as duplicate
  - Reason: Duplicate of #227 (upstream Claude Code bug)
  - Comment: Direct to #227 for full details and workaround

- [ ] **#211** - Answer and close "Cursor IDE support question"
  - Reason: Product question, not a bug report
  - Comment: Explain focus is Claude Code, but plugin architecture may allow future expansion

### Critical Bug Follow-Up

- [ ] **#254** - Follow up on "Worker API fetch failed"
  - Current status: Asked about PM2 logs (pre-v7.1.0 comment)
  - Action: Update comment asking:
    - What version of claude-mem are you running?
    - If pre-v7.1.0: Please upgrade to v7.1.0 which fixes PM2 issues
    - If v7.1.0+: Run troubleshoot skill and share logs

## Phase 2: High-Priority Merges (This Week)

### Security & Critical Fixes

- [ ] **#236** - Review and merge "Localhost-only binding" 🔒 PRIORITY
  - Impact: Security improvement (fixes network exposure)
  - Status: 156 additions, all tests pass (42/42)
  - Action: Final review, merge, update CHANGELOG

- [ ] **#212** - Review and merge "Windows path quoting fix"
  - Impact: Fixes Windows usernames with spaces
  - Status: 6 lines changed, minimal risk
  - Action: Quick cross-platform test, merge

### Major Features (Maintainer-Authored)

- [ ] **#225** - Review and merge "Export/Import scripts"
  - Impact: Enables backup/restore, partially addresses #233
  - Status: 927 additions, extensively tested by maintainer
  - Action: Final review, merge, update docs

- [ ] **#250** - Review and merge "README translations"
  - Impact: International user onboarding (22 languages)
  - Status: 10,209 additions (massive but low-risk)
  - Action: Spot-check a few translations, merge

### User-Requested Features

- [ ] **#252** - Test and merge "Execution traces" (addresses #194)
  - Impact: Shows tools/skills/MCPs in UI bubbles
  - Status: 383 additions, comprehensive implementation
  - Action: Test database migration, API endpoints, UI display

- [ ] **#251** - Test and merge "Plan file context" (addresses #180)
  - Impact: Injects last plan file into context
  - Status: 85 additions, follows existing patterns
  - Action: Test with real plan files, verify toggle works

## Phase 3: Review & Consider (Next Week)

### Quality Enhancements

- [ ] **#230** - Review "Multi-language support" (addresses #228)
  - Impact: Observations/summaries in user's language
  - Status: 157 additions, Korean screenshot provided
  - Action: Review prompt changes carefully, test with multiple languages

- [ ] **#226** - Review "CLAUDE_CONFIG_DIR support"
  - Impact: Supports non-standard Claude installations
  - Status: 10 additions, minimal change
  - Action: Test with custom config directory, merge if working

### Developer Experience

- [ ] **#216** - Review "Makefile shortcuts"
  - Impact: DX improvement for contributors
  - Status: 1,085 additions
  - Priority: Low (not urgent)
  - Action: Review when time permits

## Phase 4: Issue Follow-Ups (Ongoing)

### Awaiting User Verification

- [ ] **#209** - Follow up if no response on Windows worker startup
  - Status: Already commented asking for v7.1.0 verification
  - Action: Close if verified fixed, or investigate if still broken

- [ ] **#231** - Follow up if no response on module resolution
  - Status: Already commented asking for v7.1.0 verification
  - Action: Close if verified fixed, or investigate if still broken

### Upstream Bugs (Keep Open)

- [ ] **#227** - Keep open as documented upstream bug
  - Reason: Claude Code CLI uses invalid Windows paths
  - Action: No action needed, workaround documented

### Active Bugs (Investigate)

- [ ] **#208** - Investigate "Windows console windows appearing"
  - Priority: Medium (cosmetic but annoying)
  - Action: Reproduce on Windows, identify root cause

## Phase 5: Future Feature Planning

### Feature Requests Without PRs

- [ ] **#240** - Plan "Move MCP scaffolding to separate file"
  - Type: Internal refactoring
  - Priority: Low
  - Action: Design approach when time permits

- [ ] **#239** - Plan "Track git branch as metadata"
  - Type: Context enhancement
  - Priority: Medium
  - Action: Design schema changes, discuss approach

- [ ] **#215** - Plan "PreCompact event hook"
  - Type: Power user feature
  - Priority: Low
  - Action: Evaluate use cases, design API

- [ ] **#233** - Plan "Multi-device sync" (partial solution exists)
  - Type: Major feature
  - Note: PR #225 provides export/import, full sync is more complex
  - Action: Determine if export/import is sufficient, or plan cloud sync

## Summary

### Quick Wins (Do Today)
- Close 2 obsolete PRs (#255, #206)
- Close 3 resolved/duplicate issues (#213, #229, #211)
- Follow up on critical bug (#254)

### High-Impact Merges (This Week)
- Merge security fix (#236)
- Merge 2 simple fixes (#212, #225)
- Merge 2 major features (#250, #252, #251)

### Expected Impact
- **Security**: Localhost-only by default
- **Functionality**: Export/import, execution traces, plan context
- **UX**: Multi-language support, Windows fixes
- **Clarity**: Clean backlog, remove PM2 confusion

---

**Next Review**: After Phase 2 completion, reassess remaining items
