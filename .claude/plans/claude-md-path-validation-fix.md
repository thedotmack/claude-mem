# CLAUDE.md Path Validation Bug Fix

## Problem Summary

Claude-Mem 9.0's distributed CLAUDE.md feature has a **critical path validation bug** that creates invalid directories when Claude SDK agent outputs non-path strings in file tracking XML tags (`<files_read>`, `<files_modified>`).

### Root Cause

In `src/utils/claude-md-utils.ts:234-239`:
```typescript
if (projectRoot && !path.isAbsolute(filePath)) {
  absoluteFilePath = path.join(projectRoot, filePath);
}
```

- `path.isAbsolute('~/.claude-mem/logs')` returns `false` (Node.js doesn't recognize `~`)
- Code joins: `path.join(projectRoot, '~/.claude-mem/logs')` → `/project/~/.claude-mem/logs`
- `mkdirSync` creates literal directories

### Invalid Directories Currently in Repo

```
./~/                              ← literal tilde directory
./PR #610 on thedotmack/          ← GitHub PR reference
./git diff for src/               ← git command text
./https:/code.claude.com/docs/en/ ← URL
```

---

## Implementation Plan

### Phase 1: Add Path Validation Function

**File:** `src/utils/claude-md-utils.ts`

Add new validation function after the imports (around line 16):

```typescript
/**
 * Validate that a file path is safe for CLAUDE.md generation.
 * Rejects tilde paths, URLs, command-like strings, and paths with invalid chars.
 *
 * @param filePath - The file path to validate
 * @param projectRoot - Optional project root for boundary checking
 * @returns true if path is valid for CLAUDE.md processing
 */
function isValidPathForClaudeMd(filePath: string, projectRoot?: string): boolean {
  // Reject empty or whitespace-only
  if (!filePath || !filePath.trim()) return false;

  // Reject tilde paths (Node.js doesn't expand ~)
  if (filePath.startsWith('~')) return false;

  // Reject URLs
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) return false;

  // Reject paths with spaces (likely command text or PR references)
  if (filePath.includes(' ')) return false;

  // Reject paths with # (GitHub issue/PR references)
  if (filePath.includes('#')) return false;

  // If projectRoot provided, ensure resolved path stays within project
  if (projectRoot) {
    const resolved = path.resolve(projectRoot, filePath);
    const normalizedRoot = path.resolve(projectRoot);
    if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
      return false;
    }
  }

  return true;
}
```

### Phase 2: Integrate Validation in updateFolderClaudeMdFiles

**File:** `src/utils/claude-md-utils.ts`

Modify the file path loop in `updateFolderClaudeMdFiles` (around line 232):

```typescript
for (const filePath of filePaths) {
  if (!filePath || filePath === '') continue;

  // VALIDATE PATH BEFORE PROCESSING
  if (!isValidPathForClaudeMd(filePath, projectRoot)) {
    logger.debug('FOLDER_INDEX', 'Skipping invalid file path', {
      filePath,
      reason: 'Failed path validation'
    });
    continue;
  }

  // ... rest of existing logic unchanged
}
```

### Phase 3: Add Unit Tests

**File:** `tests/utils/claude-md-utils.test.ts`

Add new test block after existing tests:

```typescript
describe('path validation in updateFolderClaudeMdFiles', () => {
  it('should reject tilde paths', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['~/.claude-mem/logs/worker.log'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject URLs', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['https://example.com/file.ts'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject paths with spaces', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['PR #610 on thedotmack/CLAUDE.md'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject paths with hash symbols', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['issue#123/file.ts'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject path traversal outside project', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['../../../etc/passwd'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should accept valid relative paths', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['src/utils/logger.ts'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

### Phase 4: Update .gitignore

**File:** `.gitignore`

Add at end of file:

```gitignore
# Prevent literal tilde directories (path validation bug artifacts)
~*/

# Prevent other malformed path directories
http*/
https*/
```

### Phase 5: Clean Up Invalid Directories

**Command sequence:**
```bash
rm -rf "~/."
rm -rf "PR #610 on thedotmack"
rm -rf "git diff for src"
rm -rf "https:"
```

### Phase 6: Verify and Commit

1. Run test suite: `npm test`
2. Run build: `npm run build`
3. Verify no invalid directories remain
4. Commit with message: `fix: Add path validation to CLAUDE.md distribution to prevent invalid directory creation`

---

## Files Modified

| File | Change |
|------|--------|
| `src/utils/claude-md-utils.ts` | Add `isValidPathForClaudeMd()` function + integrate in loop |
| `tests/utils/claude-md-utils.test.ts` | Add 6 new path validation tests |
| `.gitignore` | Add `~*/`, `http*/`, `https*/` patterns |

## Files Deleted

| Path | Reason |
|------|--------|
| `~/` (directory tree) | Invalid literal tilde directory |
| `PR #610 on thedotmack/` | Invalid PR reference directory |
| `git diff for src/` | Invalid git command directory |
| `https:/` | Invalid URL directory |

---

## Risk Assessment

**Low Risk:**
- Validation is additive (only skips invalid paths, doesn't change valid path handling)
- Existing tests remain unchanged
- Fire-and-forget design means failures are logged but don't break hooks

**Testing Coverage:**
- 6 new unit tests covering all rejection cases
- Existing 27 tests verify valid path behavior unchanged
