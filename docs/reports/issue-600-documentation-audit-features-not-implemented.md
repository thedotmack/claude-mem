# Issue #600: Documentation Audit - Features Documented But Not Implemented

**Report Date:** 2026-01-07
**Issue Author:** @bguidolim
**Issue Created:** 2026-01-07
**Status:** Open
**Priority:** Medium-High

---

## 1. Executive Summary

A comprehensive audit by @bguidolim has identified **8 discrepancies** between the claude-mem documentation (`docs/public/`) and the actual implementation in the main branch. The core issue is that documentation describes beta-branch features as if they exist in the production release, leading to user confusion and failed feature expectations.

### Key Findings

| Category | Issue | Severity |
|----------|-------|----------|
| **Critical** | Version Channel UI missing from frontend | High |
| **Critical** | Endless Mode settings not validated/functional | High |
| **Moderate** | Troubleshoot Skill referenced but doesn't exist | Medium |
| **Moderate** | Folder CLAUDE.md setting documented but always enabled | Medium |
| **Moderate** | Skills directory documented but replaced by MCP | Medium |
| **Minor** | Allowed branches list incomplete | Low |
| **Minor** | Hook count inconsistency (5 vs 6) | Low |
| **Minor** | MCP tool count clarification needed | Low |

### Recommendation

Implement **Option B** (documentation update) for most items, with selective **Option A** (feature completion) for Version Channel UI given its near-complete backend implementation.

---

## 2. Problem Analysis

### 2.1 Documentation-Reality Gap

The documentation at `docs/public/` describes several features that:
1. Exist only in beta branches (`beta/endless-mode`, `beta/7.0`)
2. Have partial implementations (backend only, no frontend)
3. Were removed during architecture migrations (MCP transition)
4. Have non-functional settings (documented but ignored in code)

### 2.2 Impact on Users

Users following the documentation will:
- Look for UI elements that don't exist (Version Channel switcher)
- Configure settings that have no effect (Endless Mode, Folder CLAUDE.md)
- Invoke skills that don't exist (troubleshoot skill)
- Expect directory structures that don't match reality

---

## 3. Technical Details

### 3.1 Version Channel UI (High Severity)

**Documentation Claims** (`docs/public/beta-features.mdx`):
- Lines 14-24 describe a Version Channel switcher in the Settings modal
- Users should see "Settings gear icon" > "Version Channel" section
- Options include "Try Beta (Endless Mode)" and "Switch to Stable"

**Actual Implementation**:

| Component | Status | Location |
|-----------|--------|----------|
| `BranchManager.ts` | Implemented | `src/services/worker/BranchManager.ts` |
| `getBranchInfo()` | Implemented | Backend API |
| `switchBranch()` | Implemented | Backend API |
| `pullUpdates()` | Implemented | Backend API |
| `/api/branch/status` | Implemented | `SettingsRoutes.ts:169-172` |
| `/api/branch/switch` | Implemented | `SettingsRoutes.ts:178-209` |
| `/api/branch/update` | Implemented | `SettingsRoutes.ts:214-228` |
| **UI Component** | **NOT IMPLEMENTED** | `ContextSettingsModal.tsx` has no Version Channel section |

**Verification** (from `ContextSettingsModal.tsx`):
The component contains sections for:
- Loading settings (observations, sessions)
- Filters (types, concepts)
- Display settings
- Advanced settings (provider, model, port)

There is **no Version Channel section**. A grep for "Version Channel", "version channel", or "channel" in `src/ui/` returns no results.

**Related Issues**: #333, #436, #461 (all closed without merging UI)

---

### 3.2 Endless Mode Settings (High Severity)

**Documentation Claims** (`docs/public/endless-mode.mdx`):
```json
{
  "CLAUDE_MEM_ENDLESS_MODE": "false",
  "CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS": "90000"
}
```

**Actual Implementation**:

The `SettingsRoutes.ts` file (lines 87-124) defines the validated `settingKeys` array:

```typescript
const settingKeys = [
  'CLAUDE_MEM_MODEL',
  'CLAUDE_MEM_CONTEXT_OBSERVATIONS',
  'CLAUDE_MEM_WORKER_PORT',
  'CLAUDE_MEM_WORKER_HOST',
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_GEMINI_API_KEY',
  // ... 20+ other settings
  'CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE',
];
```

**Neither `CLAUDE_MEM_ENDLESS_MODE` nor `CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS` are present in this array.**

A grep for `ENDLESS_MODE` in `src/` returns only CLAUDE.md context files (auto-generated), not any TypeScript implementation.

**Current Location**: Implementation exists only in `upstream/beta/endless-mode` branch.

**Related Issues**: #366, #403, #416 (all closed, feature still in beta only)

---

### 3.3 Troubleshoot Skill (Medium Severity)

**Documentation Claims**:

`docs/public/troubleshooting.mdx` (lines 8-20):
```markdown
## Quick Diagnostic Tool

Describe any issues you're experiencing to Claude, and the troubleshoot skill
will automatically activate to provide diagnosis and fixes.

The troubleshoot skill will:
- Check worker status and health
- Verify database existence and integrity
- ...
```

`docs/public/architecture/overview.mdx` (lines 165-175):
```
plugin/skills/
├── mem-search/
├── troubleshoot/     ← Documented but doesn't exist
│   ├── SKILL.md
│   └── operations/
└── version-bump/
```

**Actual Implementation**:

```bash
$ ls plugin/skills/
ls: plugin/skills/: No such file or directory
```

The `plugin/skills/` directory **does not exist** in the main branch.

**Historical Context**: Skills were merged in PR #72 (v5.2) but later removed during the MCP migration. The documentation was not updated to reflect this architectural change.

---

### 3.4 Folder CLAUDE.md Setting (Medium Severity)

**Documentation Claims** (`docs/public/configuration.mdx`, lines 232-238):

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` | `false` | Enable auto-generation of folder CLAUDE.md files |

**Actual Implementation**:

In `ResponseProcessor.ts` (lines 216-233), folder CLAUDE.md updates are triggered unconditionally:

```typescript
// Update folder CLAUDE.md files for touched folders (fire-and-forget)
const allFilePaths: string[] = [];
for (const obs of observations) {
  allFilePaths.push(...(obs.files_modified || []));
  allFilePaths.push(...(obs.files_read || []));
}

if (allFilePaths.length > 0) {
  updateFolderClaudeMdFiles(
    allFilePaths,
    session.project,
    getWorkerPort(),
    projectRoot
  ).catch(error => {
    logger.warn('FOLDER_INDEX', 'CLAUDE.md update failed (non-critical)', ...);
  });
}
```

**The setting `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` is never read.** The feature runs unconditionally when files are touched.

Additionally, the setting is not in the `SettingsRoutes.ts` settingKeys array, so it cannot be configured through the API.

**Fix in Progress**: PR #589

---

### 3.5 Skills Directory (Medium Severity)

**Documentation Claims** (`docs/public/architecture/overview.mdx`, lines 165-175):

```
plugin/skills/
├── mem-search/
│   ├── SKILL.md
│   ├── operations/
│   └── principles/
├── troubleshoot/
└── version-bump/
```

**Actual Implementation**:

The `plugin/skills/` directory does not exist. Search functionality is now provided by MCP tools defined in `src/servers/mcp-server.ts`:

```typescript
const tools = [
  { name: '__IMPORTANT', ... },
  { name: 'search', ... },
  { name: 'timeline', ... },
  { name: 'get_observations', ... }
];
```

The skill-based architecture was replaced by MCP tools during the v6.x architecture evolution. The documentation still describes the old skill-based system.

---

### 3.6 Allowed Branches List (Low Severity)

**Location**: `SettingsRoutes.ts:187`

```typescript
const allowedBranches = ['main', 'beta/7.0', 'feature/bun-executable'];
```

**Issue**: Missing `beta/endless-mode` which exists in upstream and is documented.

---

### 3.7 Hook Count Inconsistency (Low Severity)

| Source | Stated Count |
|--------|--------------|
| `docs/public/architecture/overview.mdx` | "6 lifecycle hooks" |
| Root `CLAUDE.md` | "5 Lifecycle Hooks" |
| Actual `hooks.json` | 4 hook types (SessionStart, UserPromptSubmit, PostToolUse, Stop) |

**Actual Hooks** (from `plugin/hooks/hooks.json`):
1. SessionStart (with smart-install, worker-service, context-hook, user-message-hook)
2. UserPromptSubmit (with worker-service, new-hook)
3. PostToolUse (with worker-service, save-hook)
4. Stop (with worker-service, summary-hook)

Note: The documentation may be counting individual script invocations rather than hook types.

---

### 3.8 MCP Tool Count (Low Severity)

**Documentation Claims**: "4 MCP tools"

**Actual Tools**:
1. `__IMPORTANT` - Instructional/workflow guidance (not a functional tool)
2. `search` - Search memory index
3. `timeline` - Get chronological context
4. `get_observations` - Fetch full observation details

The claim is technically correct, but `__IMPORTANT` is workflow documentation rather than a functional tool.

---

## 4. Impact Assessment

### 4.1 User Experience Impact

| Issue | User Impact | Frequency |
|-------|-------------|-----------|
| Version Channel UI | Users cannot switch branches via UI | High - Documented prominently |
| Endless Mode | Config has no effect | Medium - Beta feature |
| Troubleshoot Skill | Skill invocation fails | High - Troubleshooting entry point |
| Folder CLAUDE.md | Setting ignored | Low - Niche feature |
| Skills Directory | Structure doesn't match | Low - Developer documentation |

### 4.2 Developer Experience Impact

| Issue | Developer Impact |
|-------|------------------|
| Architecture docs outdated | New contributors confused by skill references |
| Hook count mismatch | Onboarding confusion |
| API endpoint gaps | Integration developers encounter missing features |

---

## 5. Root Cause Analysis

### 5.1 Primary Causes

1. **Branch Divergence**: Beta branches contain features that were documented but never merged to main
2. **Architecture Migration**: The MCP transition removed the skill system but docs weren't updated
3. **Documentation-First Development**: Features were documented during planning but implementation was incomplete
4. **Missing Sync Process**: No automated check between docs and code

### 5.2 Contributing Factors

1. **Multiple Authors**: Documentation and code written by different contributors
2. **Long-Running Branches**: Beta branches existed for extended periods
3. **Incomplete PRs**: Related issues (#333, #436, #461, #366, #403, #416) were closed without merging

---

## 6. Recommended Solutions

### 6.1 Immediate Actions (This Week)

| Item | Action | Owner | Effort |
|------|--------|-------|--------|
| Troubleshoot Skill | Remove references from `troubleshooting.mdx` | Docs | 1 hour |
| Skills Directory | Update `overview.mdx` to show current MCP architecture | Docs | 2 hours |
| Hook Count | Align all sources to "5 hooks" | Docs | 30 min |
| MCP Tool Clarification | Note that `__IMPORTANT` is workflow guidance | Docs | 15 min |

### 6.2 Short-Term Actions (This Sprint)

| Item | Action | Owner | Effort |
|------|--------|-------|--------|
| Endless Mode | Add "Beta Only" badge to `endless-mode.mdx` and `beta-features.mdx` | Docs | 1 hour |
| Version Channel | Add "Beta Only" badge OR complete UI implementation | Eng/Docs | 2-8 hours |
| Folder CLAUDE.md | Merge PR #589 to respect setting | Eng | Code review |
| Allowed Branches | Add `beta/endless-mode` to allowed list | Eng | 15 min |

### 6.3 Long-Term Actions (Next Release)

| Item | Action | Owner | Effort |
|------|--------|-------|--------|
| Documentation Sync | Implement CI check for doc/code alignment | DevOps | 1 day |
| Beta Badge System | Create Mintlify component for beta feature marking | Docs | 2 hours |
| Feature Flags | Consider feature flag system for documented-but-beta features | Eng | 1 week |

---

## 7. Priority/Severity Assessment

### Severity Matrix

| Issue | Severity | Priority | Rationale |
|-------|----------|----------|-----------|
| Version Channel UI | High | P1 | Backend complete, users actively confused |
| Endless Mode | High | P2 | Documented prominently, users try to configure |
| Troubleshoot Skill | Medium | P1 | Entry point for support, must work |
| Folder CLAUDE.md | Medium | P2 | Settings should work as documented |
| Skills Directory | Medium | P3 | Developer-facing, less user impact |
| Allowed Branches | Low | P3 | Edge case |
| Hook Count | Low | P4 | Cosmetic inconsistency |
| MCP Tool Count | Low | P4 | Minor clarification |

### Recommended Resolution Order

1. **P1 - Immediate**: Fix troubleshoot skill reference (remove or explain)
2. **P1 - Immediate**: Version Channel UI decision (badge or implement)
3. **P2 - This Week**: Endless Mode documentation badges
4. **P2 - This Week**: Folder CLAUDE.md PR #589 merge
5. **P3 - This Sprint**: Architecture documentation update
6. **P4 - Eventually**: Minor inconsistencies

---

## 8. Files Requiring Updates

### Documentation Files

| File | Changes Needed |
|------|---------------|
| `docs/public/troubleshooting.mdx` | Remove troubleshoot skill reference |
| `docs/public/architecture/overview.mdx` | Update to MCP architecture, fix hook count |
| `docs/public/beta-features.mdx` | Add "Beta Only" badges, clarify UI availability |
| `docs/public/endless-mode.mdx` | Add "Beta Only" badge prominently |
| `docs/public/configuration.mdx` | Mark `FOLDER_CLAUDEMD_ENABLED` as coming soon or remove |
| `CLAUDE.md` (root) | Verify hook count |

### Code Files

| File | Changes Needed |
|------|---------------|
| `src/services/worker/http/routes/SettingsRoutes.ts` | Add `beta/endless-mode` to allowed branches |
| `src/services/worker/agents/ResponseProcessor.ts` | Check `FOLDER_CLAUDEMD_ENABLED` setting (via PR #589) |
| `src/shared/SettingsDefaultsManager.ts` | Add `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` setting |

---

## 9. Appendix

### Related Issues and PRs

| Reference | Description | Status |
|-----------|-------------|--------|
| #333 | Version Channel UI | Closed |
| #436 | Version Channel UI | Closed |
| #461 | Version Channel UI | Closed |
| #366 | Endless Mode | Closed |
| #403 | Endless Mode | Closed |
| #416 | Endless Mode | Closed |
| #589 | Folder CLAUDE.md setting fix | Open |
| #600 | This documentation audit | Open |

### Verification Commands

```bash
# Check for Version Channel UI
grep -r "Version Channel\|version.*channel" src/ui/

# Check for Endless Mode settings
grep -r "ENDLESS_MODE" src/

# Check skills directory
ls -la plugin/skills/

# Check settings validation
grep -A 50 "settingKeys" src/services/worker/http/routes/SettingsRoutes.ts
```

---

*Report generated from analysis of Issue #600 and codebase inspection on 2026-01-07.*
