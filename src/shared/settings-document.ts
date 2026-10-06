import { existsSync, renameSync } from 'fs';
import { readJsonFileWithBom, writeJsonFileAtomic } from './atomic-json.js';

export type SettingsDocument = Record<string, unknown>;

export type SettingsDocumentResult = {
  status: 'created' | 'updated' | 'unchanged' | 'refused';
  document?: SettingsDocument;
  error?: unknown;
  /** Where an unreadable settings.json was moved (quarantineCorrupt only). */
  quarantinedTo?: string;
};

const isRecord = (value: unknown): value is SettingsDocument =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * settings.json carries secrets (API keys, the CMEM Pro setup token, sync
 * tokens), so every write creates it owner-only from the first byte.
 */
const SETTINGS_FILE_MODE = 0o600;

/**
 * Where claude-mem's keys live — the ONE rule every settings reader and writer
 * uses, including SettingsDefaultsManager.loadFromFile, so a write always lands
 * where the next read looks:
 *  - nested when the `env` block holds `CLAUDE_MEM_*` keys: a Claude-Code-style
 *    wrapped document. `CLAUDE_MEM_*` keys at its root are stale copies — the
 *    old viewer wrote the root of wrapped documents, secrets as `****` masks —
 *    so they are never read, and the next write drops them;
 *  - flat otherwise: claude-mem's keys at the root, and an `env` block beside
 *    them (with no `CLAUDE_MEM_*` keys) is Claude Code's own.
 * A wrapped document keeps its wrapper and root peers.
 */
export function classifySettingsDocument(document: SettingsDocument): 'flat' | 'nested' {
  const env = document.env;
  return isRecord(env) && Object.keys(env).some(key => key.startsWith('CLAUDE_MEM_')) ? 'nested' : 'flat';
}

export function settingsTarget(document: SettingsDocument): SettingsDocument {
  return classifySettingsDocument(document) === 'nested' ? document.env as SettingsDocument : document;
}

/**
 * The document as it is written back: in a nested document, the stale root
 * `CLAUDE_MEM_*` copies are dropped, so a masked or blank copy can never be
 * read, merged, or mistaken for the real value again. A flat document is
 * returned as is.
 */
export function withoutStaleRootCopies(document: SettingsDocument): SettingsDocument {
  if (classifySettingsDocument(document) !== 'nested') return document;
  return Object.fromEntries(Object.entries(document).filter(([key]) => !key.startsWith('CLAUDE_MEM_')));
}

function cloneDocument(document: SettingsDocument): SettingsDocument {
  return JSON.parse(JSON.stringify(document)) as SettingsDocument;
}

function loadDocument(path: string): { exists: boolean; document?: SettingsDocument; error?: unknown } {
  if (!existsSync(path)) return { exists: false };
  try {
    const parsed = readJsonFileWithBom<unknown>(path);
    if (!isRecord(parsed)) return { exists: true, error: new Error('settings.json must contain a JSON object') };
    return { exists: true, document: parsed };
  } catch (error) {
    return { exists: true, error };
  }
}

/**
 * First unused `<path>.corrupt-<epoch-ms>[-n]` name, so a second quarantine in
 * the same millisecond never replaces an earlier backup.
 */
function unusedQuarantinePath(path: string): string {
  const base = `${path}.corrupt-${Date.now()}`;
  let candidate = base;
  for (let suffix = 1; existsSync(candidate); suffix++) candidate = `${base}-${suffix}`;
  return candidate;
}

/**
 * Apply `updates` (then `mutate`) to the settings target and write atomically.
 * An unreadable existing file is never overwritten: by default the write is
 * refused and reported. `quarantineCorrupt` (the installer only) instead moves
 * the unreadable file aside to `<path>.corrupt-<epoch-ms>`, keeping the user's
 * bytes, and writes a fresh document — so a corrupt file cannot stop setup. If
 * that fresh write fails, the bytes are moved back to `path`, so every reader
 * still finds the file where it was.
 */
export function updateSettingsDocument(
  path: string,
  updates: SettingsDocument,
  seed: object = {},
  mutate?: (target: SettingsDocument) => void,
  options: { quarantineCorrupt?: boolean } = {},
): SettingsDocumentResult {
  let loaded = loadDocument(path);
  let quarantinedTo: string | undefined;
  if (loaded.error) {
    if (!options.quarantineCorrupt) return { status: 'refused', error: loaded.error };
    quarantinedTo = unusedQuarantinePath(path);
    try {
      renameSync(path, quarantinedTo);
    } catch (error) {
      return { status: 'refused', error };
    }
    loaded = { exists: false };
  }
  const cloned = cloneDocument((loaded.document ?? seed) as SettingsDocument);
  if (!isRecord(cloned)) return { status: 'refused', error: new Error('settings seed must be an object') };
  const document = withoutStaleRootCopies(cloned);
  const target = settingsTarget(document);
  Object.assign(target, updates);
  mutate?.(target);
  if (loaded.exists && JSON.stringify(document) === JSON.stringify(loaded.document)) {
    return { status: 'unchanged', document };
  }
  try {
    writeJsonFileAtomic(path, document, { mode: SETTINGS_FILE_MODE });
    return { status: loaded.exists ? 'updated' : 'created', document, quarantinedTo };
  } catch (error) {
    if (quarantinedTo && restoreQuarantined(quarantinedTo, path)) quarantinedTo = undefined;
    return { status: 'refused', document: loaded.document, error, quarantinedTo };
  }
}

/**
 * Move a quarantined file back after the fresh write failed. Returns false
 * (the caller keeps reporting `quarantinedTo`) when something already took
 * `path` or the move itself fails.
 */
function restoreQuarantined(quarantinedTo: string, path: string): boolean {
  if (existsSync(path)) return false;
  try {
    renameSync(quarantinedTo, path);
    return true;
  } catch {
    // [ANTI-PATTERN IGNORED]: the write error is what the caller reports; a
    // false return keeps quarantinedTo in the result so it can say where the
    // user's bytes are.
    return false;
  }
}

export function ensureSettingsDocument(path: string, seed: object): SettingsDocumentResult {
  const loaded = loadDocument(path);
  if (loaded.error) return { status: 'refused', error: loaded.error };
  if (loaded.exists) return { status: 'unchanged', document: loaded.document };
  const document = cloneDocument(seed as SettingsDocument);
  try {
    writeJsonFileAtomic(path, document, { mode: SETTINGS_FILE_MODE });
    return { status: 'created', document };
  } catch (error) {
    return { status: 'refused', error };
  }
}
