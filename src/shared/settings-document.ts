import { existsSync } from 'fs';
import { readJsonFileWithBom, writeJsonFileAtomic } from './atomic-json.js';

export type SettingsDocument = Record<string, unknown>;
export type SettingsDocumentLayout = 'flat' | 'nested';

export type SettingsDocumentResult = {
  status: 'created' | 'updated' | 'unchanged' | 'refused' | 'missing';
  document?: SettingsDocument;
  error?: unknown;
};

const isRecord = (value: unknown): value is SettingsDocument =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function classifySettingsDocument(document: SettingsDocument): SettingsDocumentLayout {
  const rootKeys = Object.keys(document);
  if (rootKeys.some(key => key.startsWith('CLAUDE_MEM_'))) {
    return 'flat';
  }
  const env = document.env;
  if (isRecord(env) && Object.keys(env).some(key => key.startsWith('CLAUDE_'))) {
    return 'nested';
  }
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

export function canReadSettingsDocument(path: string): boolean {
  return !loadDocument(path).error;
}

export function updateSettingsDocument(
  path: string,
  updates: SettingsDocument,
  seed: object = {},
  mutate?: (target: SettingsDocument) => void,
): SettingsDocumentResult {
  const loaded = loadDocument(path);
  if (loaded.error) return { status: 'refused', error: loaded.error };
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
    return { status: loaded.exists ? 'updated' : 'created', document };
  } catch (error) {
    return { status: 'refused', document: loaded.document, error };
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

export function migrateSettingsDocumentToFlat(
  path: string,
  mutate?: (flat: SettingsDocument) => void,
): SettingsDocumentResult {
  const loaded = loadDocument(path);
  if (loaded.error) return { status: 'refused', error: loaded.error };
  if (!loaded.document) return { status: 'unchanged' };
  const isNested = classifySettingsDocument(loaded.document) === 'nested';
  let flat: SettingsDocument;
  if (isNested) {
    const nested = loaded.document.env as SettingsDocument;
    const { env: _wrapper, ...rootPeers } = loaded.document;
    flat = { ...rootPeers, ...nested };
  } else {
    flat = cloneDocument(loaded.document);
  }
  mutate?.(flat);
  if (!isNested && JSON.stringify(flat) === JSON.stringify(loaded.document)) {
    return { status: 'unchanged', document: flat };
  }
  try {
    writeJsonFileAtomic(path, flat);
    return { status: 'updated', document: flat };
  } catch (error) {
    return { status: 'refused', document: flat, error };
  }
}
