/** Checked results for the normal My Work story workflow, never a work queue. */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { batchFailure } from './owner-goals-batches.js';
import { validateStory, type StoryDraft } from './request-groups.mjs';

export type CanonicalPreferenceKey = {
  action: string;
  target: string;
  condition: string;
  polarity: 'require' | 'avoid';
};

export type PreferenceProvenance = {
  preference: Record<string, any>;
  requestIds: string[];
  legacySupportCount?: number;
};

export type StoryCache = {
  version: 1;
  context: string;
  canonical: Record<string, CanonicalPreferenceKey>;
  proofs: Array<{ storyHash: string; preferences: PreferenceProvenance[] }>;
  checkpoint?: { identity: string; readAt: number; drafts: Record<string, StoryDraft> };
};

const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const shape = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => object(value)
  && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
/** Validate the model's key without altering case, whitespace or literal identifiers. */
export function validateCanonicalPreferenceKey(value: unknown): CanonicalPreferenceKey {
  if (!shape(value, ['action', 'target', 'condition', 'polarity'])
    || typeof value.action !== 'string' || typeof value.target !== 'string' || typeof value.condition !== 'string'
    || !['require', 'avoid'].includes(value.polarity as string)) {
    throw new TypeError('A preference key needs only action, target, condition and a require/avoid polarity.');
  }
  const { action, target, condition } = value;
  if (!action.trim() || !target.trim() || action.length + target.length + condition.length > 500) {
    throw new TypeError('A preference key needs nonempty action and target, with at most 500 characters in total.');
  }
  return { action, target, condition, polarity: value.polarity as CanonicalPreferenceKey['polarity'] };
}

/** Commit to every JSON field, preserving array order and sorting object keys. */
export function storyFingerprint(value: unknown): string {
  const seen = new Set<object>();
  const sorted = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!Array.isArray(item) && !object(item)) throw new TypeError('Story fingerprints require JSON values.');
    if (seen.has(item)) throw new TypeError('Story fingerprints cannot contain cycles.');
    seen.add(item);
    try {
      return Array.isArray(item) ? item.map(sorted)
        : Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])]));
    } finally { seen.delete(item); }
  };
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}

function checkedDraft(value: unknown): StoryDraft {
  if (!shape(value, ['narrative', 'preferences']) || !Array.isArray(value.preferences)
    || !Array.from(value.preferences).every(object)) throw new TypeError('Invalid checked story draft.');
  const checked = validateStory(value);
  if (checked.preferences.some(preference => !Number.isSafeInteger(preference.supportCount))
    || storyFingerprint(checked) !== storyFingerprint(value)) {
    throw new TypeError('A cached story draft must already pass story validation without changes.');
  }
  return checked;
}

function checkedCache(value: unknown): StoryCache {
  if (!shape(value, ['version', 'context', 'canonical', 'proofs'], ['checkpoint'])
    || value.version !== 1 || typeof value.context !== 'string' || !value.context.trim()
    || !object(value.canonical) || !Array.isArray(value.proofs) || value.proofs.length > 2) {
    throw new TypeError('Invalid checked story cache.');
  }
  const canonical = Object.fromEntries(Object.entries(value.canonical).map(([id, candidate]) => {
    const checked = validateCanonicalPreferenceKey(candidate);
    if (!hash(id) || storyFingerprint(checked) !== storyFingerprint(candidate)) throw new TypeError('Invalid cached preference key.');
    return [id, checked];
  }));
  const proofHashes = new Set<string>();
  const proofs = Array.from(value.proofs, proof => {
    if (!shape(proof, ['storyHash', 'preferences']) || !hash(proof.storyHash)
      || proofHashes.has(proof.storyHash) || !Array.isArray(proof.preferences) || proof.preferences.length > 30) {
      throw new TypeError('Invalid story provenance proof.');
    }
    proofHashes.add(proof.storyHash);
    const preferences = Array.from(proof.preferences, entry => {
      if (!shape(entry, ['preference', 'requestIds'], ['legacySupportCount']) || !object(entry.preference)
        || !Array.isArray(entry.requestIds) || !Array.from(entry.requestIds).every(id => typeof id === 'string' && id.trim().length > 0)
        || new Set(entry.requestIds).size !== entry.requestIds.length
        || (Object.hasOwn(entry, 'legacySupportCount') && (!Number.isSafeInteger(entry.legacySupportCount) || (entry.legacySupportCount as number) < 0))) {
        throw new TypeError('Invalid request provenance for a story preference.');
      }
      const preference = checkedDraft({ narrative: 'Checked preference.', preferences: [entry.preference] }).preferences[0];
      if (preference.supportCount !== Math.max(entry.requestIds.length, (entry.legacySupportCount as number | undefined) ?? 0)) {
        throw new TypeError('Story support must match distinct requests or its explicit legacy lower bound.');
      }
      return { preference, requestIds: [...entry.requestIds] as string[],
        ...(entry.legacySupportCount === undefined ? {} : { legacySupportCount: entry.legacySupportCount as number }) };
    });
    return { storyHash: proof.storyHash, preferences };
  });
  let checkpoint: StoryCache['checkpoint'];
  if (Object.hasOwn(value, 'checkpoint')) {
    const candidate = value.checkpoint;
    if (!shape(candidate, ['identity', 'readAt', 'drafts']) || !hash(candidate.identity)
      || !Number.isSafeInteger(candidate.readAt) || (candidate.readAt as number) < 0
      || !Number.isFinite(new Date(candidate.readAt as number).getTime()) || !object(candidate.drafts)) {
      throw new TypeError('Invalid checked story progress.');
    }
    const drafts = Object.fromEntries(Object.entries(candidate.drafts).map(([id, draft]) => {
      if (!hash(id)) throw new TypeError('Invalid checked story source key.');
      return [id, checkedDraft(draft)];
    }));
    checkpoint = { identity: candidate.identity, readAt: candidate.readAt as number, drafts };
  }
  return { version: 1, context: value.context, canonical, proofs, ...(checkpoint ? { checkpoint } : {}) };
}

export function readStoryCache(path: string, context: string): StoryCache {
  if (typeof context !== 'string' || !context.trim()) throw batchFailure('The story cache needs a context identity.');
  let contents: string;
  try { contents = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, context, canonical: {}, proofs: [] };
    throw batchFailure('Cannot read checked story progress at ' + path + '. It has not been replaced.');
  }
  let cached: StoryCache;
  try { cached = checkedCache(JSON.parse(contents)); }
  catch { throw batchFailure('Invalid checked story progress at ' + path + '. It has not been replaced.'); }
  // Committed provenance survives model/prompt changes; inference results do not.
  return cached.context === context ? cached : { version: 1, context, canonical: {}, proofs: cached.proofs };
}

export function writeStoryCache(path: string, state: StoryCache): void {
  let contents: string;
  try { contents = JSON.stringify(checkedCache(state)); }
  catch { throw batchFailure('Refused invalid checked story progress for ' + path + '. It has not been replaced.'); }
  const temporary = path + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, contents); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
  } catch (error) {
    throw batchFailure('Could not retain checked story progress at ' + path + ': ' + String(error));
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* Preserve the original write failure. */ }
  }
}
