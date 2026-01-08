# Technical Report: Issue #599 - Windows Drive Root 400 Error

**Issue:** [#599](https://github.com/thedotmack/claude-mem/issues/599)
**Title:** user-message-hook.js fails with 400 error when running from Windows drive root (C:\)
**Author:** PakAbhishek
**Created:** 2026-01-07
**Severity:** Low
**Priority:** Medium
**Component:** Hooks / Session Initialization

---

## 1. Executive Summary

When running Claude Code from a Windows drive root directory (e.g., `C:\`), the `user-message-hook.js` script fails with a 400 HTTP error during session startup. The root cause is that `path.basename('C:\')` returns an empty string on Windows, which causes the API call to `/api/context/inject?project=` to fail with the error "Project(s) parameter is required".

**Key Findings:**

- The bug is **cosmetic only** - all core memory functionality continues to work correctly
- A robust fix already exists in `src/utils/project-name.ts` (`getProjectName()` function) but is not used by `user-message-hook.ts`
- The fix requires updating `user-message-hook.ts` to use the existing `getProjectName()` utility instead of raw `path.basename()`
- The `context-hook.ts` is already immune to this bug because it uses `getProjectContext()` which wraps `getProjectName()`

**Affected Files:**

- `src/hooks/user-message-hook.ts` (needs fix)
- `plugin/scripts/user-message-hook.js` (built artifact, auto-fixed by rebuild)

---

## 2. Problem Analysis

### 2.1 User-Reported Symptoms

1. Error message on Claude Code startup when cwd is `C:\`:
   ```
   error: Failed to fetch context: 400
         at C:\Users\achau\.claude\plugins\cache\thedotmack\claude-mem\9.0.0\scripts\user-message-hook.js:19:1339
   ```

2. The error appears during the SessionStart hook phase

3. Despite the error, all other functionality works correctly:
   - Worker health check: passing
   - MCP tools: connected and functional
   - Memory search: working
   - Session observations: saved correctly

### 2.2 Reproduction Steps

1. Open terminal on Windows
2. Navigate to drive root: `cd C:\`
3. Start Claude Code: `claude`
4. Observe the startup error

### 2.3 Environment

- **OS:** Windows 11
- **claude-mem version:** 9.0.0
- **Bun version:** 1.3.5
- **Claude Code:** Latest

---

## 3. Technical Details

### 3.1 Code Flow Analysis

The `user-message-hook.ts` extracts the project name using:

```typescript
// File: src/hooks/user-message-hook.ts (lines 18-23)
const project = basename(process.cwd());

const response = await fetch(
  `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}&colors=true`,
  { method: 'GET' }
);
```

When `process.cwd()` returns `C:\`, the `path.basename()` function returns an empty string:

```javascript
> require('path').basename('C:\\')
''
```

This results in an API call to:
```
/api/context/inject?project=&colors=true
```

### 3.2 Server-Side Validation

The `/api/context/inject` endpoint in `SearchRoutes.ts` performs strict validation:

```typescript
// File: src/services/worker/http/routes/SearchRoutes.ts (lines 207-223)
private handleContextInject = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
  const projectsParam = (req.query.projects as string) || (req.query.project as string);
  const useColors = req.query.colors === 'true';

  if (!projectsParam) {
    this.badRequest(res, 'Project(s) parameter is required');
    return;
  }

  const projects = projectsParam.split(',').map(p => p.trim()).filter(Boolean);

  if (projects.length === 0) {
    this.badRequest(res, 'At least one project is required');
    return;
  }
  // ...
});
```

The validation correctly rejects empty project names, returning HTTP 400.

### 3.3 Existing Solution

A robust solution already exists in `src/utils/project-name.ts`:

```typescript
// File: src/utils/project-name.ts (lines 12-40)
export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  const basename = path.basename(cwd);

  // Edge case: Drive roots on Windows (C:\, J:\) or Unix root (/)
  // path.basename('C:\') returns '' (empty string)
  if (basename === '') {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      const driveMatch = cwd.match(/^([A-Z]):\\/i);
      if (driveMatch) {
        const driveLetter = driveMatch[1].toUpperCase();
        const projectName = `drive-${driveLetter}`;
        logger.info('PROJECT_NAME', 'Drive root detected', { cwd, projectName });
        return projectName;
      }
    }
    logger.warn('PROJECT_NAME', 'Root directory detected, using fallback', { cwd });
    return 'unknown-project';
  }

  return basename;
}
```

This function:
- Handles null/undefined cwd
- Handles empty basename (drive roots)
- Returns meaningful names like `drive-C`, `drive-D` for Windows drive roots
- Returns `unknown-project` for Unix root or other edge cases

### 3.4 Comparison: Fixed vs. Unfixed Hooks

| Hook | Implementation | Status |
|------|---------------|--------|
| `context-hook.ts` | Uses `getProjectContext()` which calls `getProjectName()` | Immune to bug |
| `user-message-hook.ts` | Uses raw `basename(process.cwd())` | **Vulnerable** |
| `new-hook.ts` | Receives `cwd` from stdin, uses `getProjectName()` | Immune to bug |
| `save-hook.ts` | Uses basename but receives cwd from API context | Context-dependent |

---

## 4. Impact Assessment

### 4.1 Severity: Low

- **Functional Impact:** Cosmetic only - the error message is displayed but does not affect core functionality
- **Data Integrity:** No data loss or corruption
- **Workaround Available:** Yes - run Claude from a project directory instead of drive root

### 4.2 Affected Users

- Users running Claude Code from Windows drive roots (C:\, D:\, etc.)
- Estimated as a small percentage of users based on typical usage patterns
- More likely to affect users doing quick tests or troubleshooting

### 4.3 User Experience Impact

- Confusing error message on startup
- Users may incorrectly believe the plugin is broken
- Error appears in stderr alongside legitimate context information

---

## 5. Root Cause Analysis

### 5.1 Primary Cause

The `user-message-hook.ts` was implemented using a direct `path.basename()` call instead of the standardized `getProjectName()` utility function that handles edge cases.

### 5.2 Contributing Factors

1. **Inconsistent Pattern Usage:** Different hooks use different approaches to extract project names
2. **Missing Validation:** No client-side validation of project name before making API call
3. **Edge Case Not Tested:** Windows drive root is an unusual but valid working directory

### 5.3 Historical Context

The `getProjectName()` utility was added to handle this exact edge case (see `src/utils/project-name.ts`), but not all hooks were updated to use it. The `context-hook.ts` uses the newer `getProjectContext()` function, while `user-message-hook.ts` still uses the older pattern.

---

## 6. Recommended Solutions

### 6.1 Primary Fix (Recommended)

Update `user-message-hook.ts` to use the existing `getProjectName()` utility:

```typescript
// Current (vulnerable):
import { basename } from "path";
const project = basename(process.cwd());

// Fixed:
import { getProjectName } from "../utils/project-name.js";
const project = getProjectName(process.cwd());
```

**Benefits:**
- Uses battle-tested utility
- Consistent with other hooks
- Handles all edge cases (drive roots, Unix root, empty cwd)
- Provides meaningful project names (`drive-C`) instead of fallbacks

### 6.2 Alternative: Inline Fix (User-Suggested)

The user suggested an inline fix in the issue:

```javascript
let projectName = basename(process.cwd());
if (!projectName || projectName === '') {
  const cwd = process.cwd();
  projectName = cwd.match(/^([A-Za-z]:)[\\/]?$/)
    ? `drive-${cwd[0].toUpperCase()}`
    : 'unknown-project';
}
```

**Evaluation:**
- Functionally correct
- Duplicates existing logic in `getProjectName()`
- Does not address the pattern inconsistency
- Acceptable if import constraints prevent using the utility

### 6.3 Additional Improvements (Optional)

1. **Add Client-Side Validation:**
   ```typescript
   if (!project || project.trim() === '') {
     throw new Error('Unable to determine project name from working directory');
   }
   ```

2. **Standardize All Hooks:** Audit other hooks using `basename(process.cwd())` and update to use `getProjectName()`

3. **Add Unit Tests:** Create tests for `user-message-hook.ts` covering:
   - Normal project directories
   - Windows drive roots (C:\, D:\)
   - Unix root (/)
   - Trailing slashes

---

## 7. Priority and Severity Assessment

### 7.1 Classification

| Metric | Value | Justification |
|--------|-------|---------------|
| **Severity** | Low | Cosmetic error only, no functional impact |
| **Priority** | Medium | User-facing error, easy fix, affects Windows users |
| **Effort** | Trivial | Single line change + rebuild |
| **Risk** | Very Low | Using existing, tested utility function |

### 7.2 Recommendation

**Recommended Action:** Fix in next patch release (9.0.1)

**Rationale:**
- Simple fix with minimal risk
- Improves Windows user experience
- Demonstrates responsiveness to community feedback
- Pattern already exists in codebase

### 7.3 Testing Requirements

1. Verify fix on Windows with `C:\` as cwd
2. Verify existing behavior unchanged for normal project directories
3. Verify worktree detection still works correctly
4. Run full hook test suite

---

## 8. Appendix

### 8.1 Related Files

| File | Purpose | Fix Required |
|------|---------|--------------|
| `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/src/hooks/user-message-hook.ts` | Source hook (needs fix) | Yes |
| `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/plugin/scripts/user-message-hook.js` | Built hook | Auto-rebuilds |
| `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/src/utils/project-name.ts` | Utility (has fix) | No |
| `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/src/hooks/context-hook.ts` | Reference implementation | No |
| `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/src/services/worker/http/routes/SearchRoutes.ts` | API validation | No |

### 8.2 Related Issues

- Windows compatibility has been a focus area, with 56+ memory entries documenting Windows-specific fixes
- This issue follows the pattern of other Windows edge case bugs

### 8.3 References

- [Node.js path.basename documentation](https://nodejs.org/api/path.html#pathbasenamepath-suffix)
- [Windows file system path formats](https://docs.microsoft.com/en-us/windows/win32/fileio/naming-a-file)
