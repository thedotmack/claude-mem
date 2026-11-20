import { join, dirname, basename, sep } from 'path';
import { homedir } from 'os';
import { mkdirSync, chmodSync } from 'fs';
import { fileURLToPath } from 'url';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { resolveDataDir } from './data-dir.js';
import { expandHome } from './expand-home.js';

export { expandHome } from './expand-home.js';
export { resolveDataDir } from './data-dir.js';

function getDirname(): string {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  return dirname(fileURLToPath(import.meta.url));
}

const _dirname = getDirname();

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

/** The owner-only mode for a directory that holds credentials or captured content. */
export const OWNER_ONLY_DIR_MODE = 0o700;

/**
 * Create a directory only its owner can read, and narrow an existing one to the same mode.
 *
 * `mkdirSync` alone is subject to the umask, so an install created under a permissive umask would
 * leave `~/.claude-mem` — the database, `.env` and the hook spool live there — readable by every
 * other account on the machine. The chmod tightens directories that already exist, the way
 * `claude-mem-launcher.ts` and `auto-update-launch.ts` treat the folders they own. Windows applies
 * no mode: the profile's own ACL already limits the data directory to the user.
 */
export function ensurePrivateDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  if (process.platform === 'win32') return;
  try {
    chmodSync(dirPath, OWNER_ONLY_DIR_MODE);
  } catch {
    // A filesystem that refuses chmod (some network mounts) must not stop startup; the mkdir mode still applies.
  }
}

/** mkdir failures that retrying can never fix: the data dir is a file, sits under one, or is not writable. */
const PERMANENT_DIRECTORY_ERROR_CODES = new Set(['ENOTDIR', 'EEXIST', 'EACCES', 'EPERM', 'EROFS']);

export const OBSERVER_WORKING_DIRECTORY_ERROR_PREFIX = 'Observer working directory could not be prepared';

/**
 * Create the Observer/KnowledgeAgent working directory before an SDK spawn.
 *
 * A permanent mkdir failure is rethrown as a message that classifyClaudeError
 * maps to `setup_required`, so it is recorded once instead of retried on every
 * ingest. Anything else (EMFILE, ENFILE, EIO, ENOSPC …) is rethrown unchanged:
 * a passing file-system hiccup must not park Claude starts behind the setup
 * cooldown. `makeDirectory` is a test seam; production callers omit it.
 */
export function ensureObserverSessionsDir(
  dir: string = OBSERVER_SESSIONS_DIR,
  makeDirectory: (dirPath: string) => void = ensureDir,
): string {
  try {
    makeDirectory(dir);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !PERMANENT_DIRECTORY_ERROR_CODES.has(code)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${OBSERVER_WORKING_DIRECTORY_ERROR_PREFIX}: ${dir} (${code}): ${detail}`);
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
  workerHeartbeat: () => join(DATA_DIR, 'worker-heartbeat.json'),
  // Phase 1b: identifier renamed to `server*`; the on-disk file basenames
  // remain `.server-beta.*` so existing installations keep finding their
  // pid/port/runtime state. Plan §1d will migrate the basenames.
  serverPid: () => join(DATA_DIR, '.server-beta.pid'),
  serverPort: () => join(DATA_DIR, '.server-beta.port'),
  serverRuntime: () => join(DATA_DIR, '.server-beta.runtime.json'),
  settings: () => join(DATA_DIR, 'settings.json'),
  database: () => join(DATA_DIR, DB_FILENAME),
  // Automatic snapshot target (BackupManager). Nested under backups/auto so
  // the manager's retention sweep never touches the legacy one-off backups
  // that live directly in backups/.
  backups: () => join(DATA_DIR, 'backups', 'auto'),
  // A restore staged by `npx claude-mem restore`, applied by the next worker
  // boot before it opens the database, and the outcome of the last one.
  pendingRestore: () => join(DATA_DIR, 'backups', 'restore-pending.json'),
  lastRestore: () => join(DATA_DIR, 'backups', 'last-restore.json'),
  chroma: () => join(DATA_DIR, 'chroma'),
  combinedCerts: () => join(DATA_DIR, 'combined_certs.pem'),
  transcriptsConfig: () => join(DATA_DIR, 'transcript-watch.json'),
  transcriptsState: () => join(DATA_DIR, 'transcript-watch-state.json'),
  corpora: () => join(DATA_DIR, 'corpora'),
  supervisorRegistry: () => join(DATA_DIR, 'supervisor.json'),
  envFile: () => join(DATA_DIR, '.env'),
  logsDir: () => LOGS_DIR,
} as const;
