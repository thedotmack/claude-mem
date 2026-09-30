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
 * Where claude-mem's keys live. Root `CLAUDE_MEM_*` keys mean a flat document
 * (any `env` block beside them belongs to Claude Code); otherwise an `env`
 * block holding `CLAUDE_*` keys is a Claude-Code-style wrapped document. This
 * is the ONE rule every settings reader and writer uses, including
 * SettingsDefaultsManager.loadFromFile, so a write always lands where the next
 * read looks. A wrapped document keeps its wrapper and root peers.
 */
export function classifySettingsDocument(document: SettingsDocument): 'flat' | 'nested' {
  if (Object.keys(document).some(key => key.startsWith('CLAUDE_MEM_'))) return 'flat';
  const env = document.env;
  if (isRecord(env) && Object.keys(env).some(key => key.startsWith('CLAUDE_'))) return 'nested';
  return 'flat';
}

export function settingsTarget(document: SettingsDocument): SettingsDocument {
  return classifySettingsDocument(document) === 'nested' ? document.env as SettingsDocument : document;
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
 * Apply `updates` (then `mutate`) to the settings target and write atomically.
 * An unreadable existing file is never overwritten: by default the write is
 * refused and reported. `quarantineCorrupt` (the installer only) instead moves
 * the unreadable file aside to `<path>.corrupt-<epoch-ms>`, keeping the user's
 * bytes, and writes a fresh document — so a corrupt file cannot stop setup.
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
    quarantinedTo = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, quarantinedTo);
    } catch (error) {
      return { status: 'refused', error };
    }
    loaded = { exists: false };
  }
  const document = cloneDocument((loaded.document ?? seed) as SettingsDocument);
  if (!isRecord(document)) return { status: 'refused', error: new Error('settings seed must be an object') };
  const target = settingsTarget(document);
  Object.assign(target, updates);
  mutate?.(target);
  if (loaded.exists && JSON.stringify(document) === JSON.stringify(loaded.document)) {
    return { status: 'unchanged', document };
  }
  try {
    writeJsonFileAtomic(path, document);
    return { status: loaded.exists ? 'updated' : 'created', document, quarantinedTo };
  } catch (error) {
    return { status: 'refused', document: loaded.document, error, quarantinedTo };
  }
}

export function ensureSettingsDocument(path: string, seed: object): SettingsDocumentResult {
  const loaded = loadDocument(path);
  if (loaded.error) return { status: 'refused', error: loaded.error };
  if (loaded.exists) return { status: 'unchanged', document: loaded.document };
  const document = cloneDocument(seed as SettingsDocument);
  try {
    writeJsonFileAtomic(path, document);
    return { status: 'created', document };
  } catch (error) {
    return { status: 'refused', error };
  }
}
