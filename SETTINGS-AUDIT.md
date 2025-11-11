# Settings Usage Audit for claude-mem

## Files That Access Settings

### src/shared/paths.ts
- **Settings accessed:**
  - `CLAUDE_MEM_DATA_DIR` (environment variable)
  - `CLAUDE_CONFIG_DIR` (environment variable)
  
- **Access method:** Direct `process.env` access
- **Line numbers:** 25-26
- **Code snippets:**
  ```typescript
  export const DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
  export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  ```

### src/shared/worker-utils.ts
- **Settings accessed:**
  - `CLAUDE_MEM_WORKER_PORT` (from `~/.claude-mem/settings.json` or environment variable)
  
- **Access method:** File read with fallback to `process.env`
- **Line numbers:** 16-27
- **Priority:** Settings file > environment variable > default (37777)
- **Code snippet:**
  ```typescript
  export function getWorkerPort(): number {
    try {
      const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const port = parseInt(settings.env?.CLAUDE_MEM_WORKER_PORT, 10);
        if (!isNaN(port)) return port;
      }
    } catch {
      // Fall through to env var or default
    }
    return parseInt(process.env.CLAUDE_MEM_WORKER_PORT || '37777', 10);
  }
  ```

### src/hooks/context-hook.ts
- **Settings accessed:**
  - `CLAUDE_MEM_CONTEXT_OBSERVATIONS` (from `~/.claude/settings.json` or environment variable)
  
- **Access method:** File read with fallback to `process.env`
- **Line numbers:** 16-31
- **Priority:** Settings file > environment variable > default (50)
- **Code snippet:**
  ```typescript
  function getContextDepth(): number {
    try {
      const settingsPath = path.join(homedir(), '.claude', 'settings.json');
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        if (settings.env?.CLAUDE_MEM_CONTEXT_OBSERVATIONS) {
          const count = parseInt(settings.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10);
          if (!isNaN(count) && count > 0) {
            return count;
          }
        }
      }
    } catch {
      // Fall through to env var or default
    }
    return parseInt(process.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50', 10);
  }
  ```

### src/utils/logger.ts
- **Settings accessed:**
  - `CLAUDE_MEM_LOG_LEVEL` (environment variable)
  
- **Access method:** Direct `process.env` access
- **Line numbers:** 29
- **Code snippet:**
  ```typescript
  const envLevel = process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase() || 'INFO';
  ```

### src/services/worker/SDKAgent.ts
- **Settings accessed:**
  - `CLAUDE_CODE_PATH` (environment variable)
  - `CLAUDE_MEM_MODEL` (from `~/.claude-mem/settings.json` or environment variable)
  
- **Access method:** Mixed (env var for CLAUDE_CODE_PATH, file read with fallback for CLAUDE_MEM_MODEL)
- **Line numbers:** 344, 358-370
- **Code snippets:**
  ```typescript
  // Line 344 - CLAUDE_CODE_PATH
  const claudePath = process.env.CLAUDE_CODE_PATH ||
    execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { encoding: 'utf8' })
      .trim().split('\n')[0].trim();

  // Lines 358-370 - CLAUDE_MEM_MODEL
  private getModelId(): string {
    try {
      const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const modelId = settings.env?.CLAUDE_MEM_MODEL;
        if (modelId) return modelId;
      }
    } catch {
      // Fall through to env var or default
    }
    return process.env.CLAUDE_MEM_MODEL || 'claude-haiku-4-5';
  }
  ```

### src/services/worker-service.ts
- **Settings accessed:**
  - `CLAUDE_MEM_MODEL` (from `~/.claude/settings.json` with fallback)
  - `CLAUDE_MEM_CONTEXT_OBSERVATIONS` (from `~/.claude/settings.json` with fallback)
  - `CLAUDE_MEM_WORKER_PORT` (from `getWorkerPort()` utility)
  
- **Access method:** File read (via dedicated endpoint) + utility function
- **Line numbers:** 606-635 (handleGetSettings), 640-699 (handleUpdateSettings)
- **Code snippet (GET /api/settings):**
  ```typescript
  private handleGetSettings(req: Request, res: Response): void {
    try {
      const settingsPath = path.join(homedir(), '.claude', 'settings.json');
      if (!existsSync(settingsPath)) {
        res.json({
          CLAUDE_MEM_MODEL: 'claude-haiku-4-5',
          CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
          CLAUDE_MEM_WORKER_PORT: '37777'
        });
        return;
      }
      const settingsData = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsData);
      const env = settings.env || {};
      res.json({
        CLAUDE_MEM_MODEL: env.CLAUDE_MEM_MODEL || 'claude-haiku-4-5',
        CLAUDE_MEM_CONTEXT_OBSERVATIONS: env.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50',
        CLAUDE_MEM_WORKER_PORT: env.CLAUDE_MEM_WORKER_PORT || '37777'
      });
    } catch (error) {
      logger.failure('WORKER', 'Get settings failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
  ```

### src/services/worker/SettingsManager.ts
- **Settings accessed:** None directly - manages viewer UI settings in database
- **Access method:** SQLite database queries
- **Line numbers:** N/A (this manages viewer_settings table, not claude-mem settings)

### src/services/sqlite/SessionStore.ts
- **Settings accessed:** None - uses `DATA_DIR` constant from paths.ts
- **Access method:** Imported constant
- **Line numbers:** 2, 13
- **Code snippet:**
  ```typescript
  import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
  // Later in constructor:
  ensureDir(DATA_DIR);
  ```

### src/services/sqlite/SessionSearch.ts
- **Settings accessed:** None - uses `DATA_DIR` and `DB_PATH` constants from paths.ts
- **Access method:** Imported constants
- **Line numbers:** 2, 23-24
- **Code snippet:**
  ```typescript
  import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
  // Later:
  if (!dbPath) {
    ensureDir(DATA_DIR);
    dbPath = DB_PATH;
  }
  ```

### src/services/sqlite/Database.ts
- **Settings accessed:** None - uses `DATA_DIR` and `DB_PATH` constants from paths.ts
- **Access method:** Imported constants
- **Line numbers:** 2
- **Code snippet:**
  ```typescript
  import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
  ```

### src/ui/viewer/constants/settings.ts
- **Settings accessed:**
  - Default values for `CLAUDE_MEM_MODEL`, `CLAUDE_MEM_CONTEXT_OBSERVATIONS`, `CLAUDE_MEM_WORKER_PORT`
  
- **Access method:** Hard-coded default constants
- **Line numbers:** 5-9
- **Code snippet:**
  ```typescript
  export const DEFAULT_SETTINGS = {
    CLAUDE_MEM_MODEL: 'claude-haiku-4-5',
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
    CLAUDE_MEM_WORKER_PORT: '37777',
  } as const;
  ```

### src/ui/viewer/hooks/useSettings.ts
- **Settings accessed:** Settings fetched from HTTP API endpoint
- **Access method:** HTTP fetch to `/api/settings` endpoint (backend)
- **Line numbers:** 14-25
- **Code snippet:**
  ```typescript
  useEffect(() => {
    // Load initial settings
    fetch(API_ENDPOINTS.SETTINGS)
      .then(res => res.json())
      .then(data => {
        setSettings({
          CLAUDE_MEM_MODEL: data.CLAUDE_MEM_MODEL || DEFAULT_SETTINGS.CLAUDE_MEM_MODEL,
          CLAUDE_MEM_CONTEXT_OBSERVATIONS: data.CLAUDE_MEM_CONTEXT_OBSERVATIONS || DEFAULT_SETTINGS.CLAUDE_MEM_CONTEXT_OBSERVATIONS,
          CLAUDE_MEM_WORKER_PORT: data.CLAUDE_MEM_WORKER_PORT || DEFAULT_SETTINGS.CLAUDE_MEM_WORKER_PORT
        });
      })
      .catch(error => {
        console.error('Failed to load settings:', error);
      });
  }, []);
  ```

### src/hooks/new-hook.ts
- **Settings accessed:** None directly - uses `getWorkerPort()` utility
- **Access method:** Imported utility function
- **Line numbers:** 10, 46
- **Code snippet:**
  ```typescript
  import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
  // Later:
  const port = getWorkerPort();
  ```

### src/hooks/save-hook.ts
- **Settings accessed:** None directly - uses `getWorkerPort()` utility
- **Access method:** Imported utility function
- **Line numbers:** 10, 53
- **Code snippet:**
  ```typescript
  import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
  // Later:
  const port = getWorkerPort();
  ```

### src/hooks/summary-hook.ts
- **Settings accessed:** None directly - uses `getWorkerPort()` utility
- **Access method:** Imported utility function
- **Line numbers:** 10, 38
- **Code snippet:**
  ```typescript
  import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
  // Later:
  const port = getWorkerPort();
  ```

### src/hooks/cleanup-hook.ts
- **Settings accessed:** None directly - uses `getWorkerPort()` utility
- **Access method:** Imported utility function
- **Line numbers:** 8, 75
- **Code snippet:**
  ```typescript
  import { getWorkerPort } from '../shared/worker-utils.js';
  // Later:
  const workerPort = session.worker_port || getWorkerPort();
  ```

### src/services/worker-service-LEGACY.ts
- **Settings accessed:**
  - `CLAUDE_MEM_MODEL` (environment variable with fallback)
  - Settings from `~/.claude/settings.json`
  
- **Access method:** Mixed (env var + file read)
- **Line numbers:** 26, 47-48, 414-446, 468-490
- **Note:** LEGACY file - not actively used but contains old settings logic

---

## Summary

### Total Files Accessing Settings: 14 active files

### All Unique Settings Found:

1. **`CLAUDE_MEM_WORKER_PORT`** (default: 37777)
   - Files: `src/shared/worker-utils.ts`, `src/services/worker-service.ts`, `src/ui/viewer/constants/settings.ts`
   - Priority: `~/.claude-mem/settings.json` > `process.env` > default
   - **Source locations:** `~/.claude-mem/settings.json` (env.CLAUDE_MEM_WORKER_PORT)

2. **`CLAUDE_MEM_MODEL`** (default: claude-haiku-4-5)
   - Files: `src/services/worker/SDKAgent.ts`, `src/services/worker-service.ts`, `src/ui/viewer/constants/settings.ts`
   - Priority: `~/.claude-mem/settings.json` > `process.env` > default
   - **Source locations:** `~/.claude-mem/settings.json` (env.CLAUDE_MEM_MODEL)

3. **`CLAUDE_MEM_CONTEXT_OBSERVATIONS`** (default: 50)
   - Files: `src/hooks/context-hook.ts`, `src/services/worker-service.ts`, `src/ui/viewer/constants/settings.ts`
   - Priority: `~/.claude/settings.json` > `process.env` > default
   - **Source locations:** `~/.claude/settings.json` (env.CLAUDE_MEM_CONTEXT_OBSERVATIONS)

4. **`CLAUDE_MEM_LOG_LEVEL`** (default: INFO)
   - Files: `src/utils/logger.ts`
   - **Source:** `process.env` only
   - **Values:** DEBUG, INFO, WARN, ERROR, SILENT

5. **`CLAUDE_MEM_DATA_DIR`** (default: ~/.claude-mem)
   - Files: `src/shared/paths.ts`
   - **Source:** `process.env` only
   - **Used by:** All database operations

6. **`CLAUDE_CONFIG_DIR`** (default: ~/.claude)
   - Files: `src/shared/paths.ts`
   - **Source:** `process.env` only
   - **Used by:** Context hook and settings

7. **`CLAUDE_CODE_PATH`**
   - Files: `src/services/worker/SDKAgent.ts`
   - **Source:** `process.env` only (fallback to `which claude` / `where claude`)
   - **Purpose:** Location of Claude Code executable

---

## Files Needing Refactoring/Attention

### Low Priority
- **`src/services/worker-service-LEGACY.ts`** - LEGACY file, can be deleted once confirmed not in use
- **`src/ui/viewer/components/Sidebar.tsx`** and other UI files that reference settings in comments

### Note on Architecture
The current settings architecture has **inconsistent file locations**:
- **Worker port & model:** Read from `~/.claude-mem/settings.json`
- **Context observations:** Read from `~/.claude/settings.json`

This discrepancy should be documented or standardized. Consider:
- **Option A:** Move all to `~/.claude/settings.json` (more consistent with Claude Code conventions)
- **Option B:** Move all to `~/.claude-mem/settings.json` (plugin-specific)

### Best Practices Currently Followed
✓ Centralized setting retrieval via utility functions (`getWorkerPort()`)
✓ Consistent fallback pattern: file > env var > default
✓ Type-safe defaults in constants
✓ HTTP API endpoint for remote settings access
✓ Clean separation between worker settings and viewer settings

