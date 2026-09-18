import { join, dirname, basename, sep } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { parseJsonWithBom } from './atomic-json.js';
import { expandHome } from './expand-home.js';

export { expandHome } from './expand-home.js';

function getDirname(): string {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  return dirname(fileURLToPath(import.meta.url));
}

const _dirname = getDirname();

export function resolveDataDir(): string {
  if (process.env.CLAUDE_MEM_DATA_DIR) {
    return expandHome(process.env.CLAUDE_MEM_DATA_DIR);
  }

  const defaultDataDir = join(homedir(), '.claude-mem');
  const settingsPath = join(defaultDataDir, 'settings.json');
  try {
    if (existsSync(settingsPath)) {
      const raw = parseJsonWithBom<Record<string, any>>(readFileSync(settingsPath, 'utf-8'));
      const settings = raw.env ?? raw;
      if (settings.CLAUDE_MEM_DATA_DIR) {
        return expandHome(settings.CLAUDE_MEM_DATA_DIR);
      }
    }
  } catch {
    // settings file missing or corrupt — fall through to default
  }

  return defaultDataDir;
}

export const DATA_DIR = resolveDataDir();
// #2753 — the literal default config dir, independent of process.env state.
// Lets callers (oauth-token.ts) compare an *effective* config dir against the
// TRUE default rather than against CLAUDE_CONFIG_DIR (which already folds in
// process.env). Purely additive: does not change CLAUDE_CONFIG_DIR's own
// derivation or MARKETPLACE_ROOT below.
export const DEFAULT_CLAUDE_CONFIG_DIR = join(homedir(), '.claude');
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || DEFAULT_CLAUDE_CONFIG_DIR;

export const MARKETPLACE_ROOT = join(CLAUDE_CONFIG_DIR, 'plugins', 'marketplaces', 'thedotmack');

export const LOGS_DIR = join(DATA_DIR, 'logs');
export const USER_SETTINGS_PATH = join(DATA_DIR, 'settings.json');
export const DB_FILENAME = 'claude-mem.db';

/**
 * Database path resolved at CALL time. `DB_PATH` freezes `DATA_DIR` at import,
 * which is right for long-lived processes but wrong for anything that must
 * honor a `CLAUDE_MEM_DATA_DIR` set after this module was loaded.
 */
export function resolveDbPath(): string {
  return join(resolveDataDir(), DB_FILENAME);
}

export const DB_PATH = join(DATA_DIR, DB_FILENAME);

export const OBSERVER_SESSIONS_DIR = join(DATA_DIR, 'observer-sessions');

export const OBSERVER_SESSIONS_PROJECT = basename(OBSERVER_SESSIONS_DIR);

export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

/**
 * Observer working directory resolved at CALL time. `OBSERVER_SESSIONS_DIR`
 * freezes `DATA_DIR` at import, so a `CLAUDE_MEM_DATA_DIR` that changes after
 * this module loaded — or arrives home-relative — is not reflected. Mirrors
 * `resolveDbPath()`, which exists for the same staleness reason.
 */
export function resolveObserverSessionsDir(): string {
  return join(resolveDataDir(), 'observer-sessions');
}

/**
 * Resolve, create, and confirm the Observer/KnowledgeAgent working directory
 * before an SDK spawn. The SDK refuses to spawn when its `cwd` is missing and
 * reports a bare `Path "<dir>" does not exist`; creating and verifying the
 * directory here turns a broken data-directory setting into an actionable
 * setup error (classifyClaudeError maps the message to `setup_required`)
 * instead of a silent crash that retries forever.
 */
export function ensureObserverSessionsDir(): string {
  const dir = resolveObserverSessionsDir();
  try {
    ensureDir(dir);
  } catch (error) {
    // A data dir that is a file, has a non-directory parent, or is unwritable
    // makes mkdir throw ENOTDIR / EEXIST / EACCES — a permanent setup problem,
    // not a transient one. Rethrow with a message classifyClaudeError maps to
    // `setup_required` so it is recorded, not retried on every later ingest.
    const code = (error as { code?: string }).code;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Observer working directory could not be prepared: ${dir}${code ? ` (${code})` : ''}: ${detail}`,
    );
  }
  if (!existsSync(dir)) {
    throw new Error(`Observer working directory does not exist: ${dir}`);
  }
  return dir;
}

export function getPackageRoot(): string {
  return join(_dirname, '..');
}

/**
 * Expand a leading `~` / `~/` (or `~\` on Windows) to the user's home dir.
 *
 * User-typed config paths like `~/.local/bin/claude` are never expanded by the
 * shell when passed programmatically to existsSync/posix_spawn, so a literal
 * `~` reaches the syscall and fails with ENOENT. Every other home-relative path
 * in the codebase is built with join(homedir(), ...); this brings user-supplied
 * ones onto the same footing. Non-tilde paths are returned unchanged.
 *
 * `home` is injectable so callers behind a homedir() test seam stay testable.
 */
export function expandTilde(
  filePath: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return expandHome(filePath, platform, home);
}

export const paths = {
  dataDir: () => DATA_DIR,
  workerPid: () => join(DATA_DIR, 'worker.pid'),
  // Phase 1b: identifier renamed to `server*`; the on-disk file basenames
  // remain `.server-beta.*` so existing installations keep finding their
  // pid/port/runtime state. Plan §1d will migrate the basenames.
  serverPid: () => join(DATA_DIR, '.server-beta.pid'),
  serverPort: () => join(DATA_DIR, '.server-beta.port'),
  serverRuntime: () => join(DATA_DIR, '.server-beta.runtime.json'),
  settings: () => join(DATA_DIR, 'settings.json'),
  database: () => join(DATA_DIR, DB_FILENAME),
  chroma: () => join(DATA_DIR, 'chroma'),
  combinedCerts: () => join(DATA_DIR, 'combined_certs.pem'),
  transcriptsConfig: () => join(DATA_DIR, 'transcript-watch.json'),
  transcriptsState: () => join(DATA_DIR, 'transcript-watch-state.json'),
  corpora: () => join(DATA_DIR, 'corpora'),
  supervisorRegistry: () => join(DATA_DIR, 'supervisor.json'),
  envFile: () => join(DATA_DIR, '.env'),
  logsDir: () => LOGS_DIR,
} as const;
