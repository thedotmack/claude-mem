import { describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStoryCache, storyFingerprint, validateCanonicalPreferenceKey, writeStoryCache, type StoryCache } from '../../src/services/work-view/story-cache.js';

const CONTEXT = storyFingerprint({ device: 'local', model: 'selected-model', prompt: 'canonical-v1' });
const SOURCE = storyFingerprint({ request: 'one', preference: 'Run tests.' });
const key = () => validateCanonicalPreferenceKey({ action: 'run', target: 'tests', condition: 'before committing', polarity: 'require' });
const preference = () => ({ preference: 'Run tests before committing.', kind: 'directive', supportCount: 2,
  quotes: [{ quote: 'Please run tests.', at: null }] });
const state = (): StoryCache => ({ version: 1, context: CONTEXT, canonical: { [SOURCE]: key() },
  proofs: [{ storyHash: storyFingerprint({ story: 'saved' }), preferences: [{ preference: preference(), requestIds: ['request-a', 'request-b'] }] }],
  checkpoint: { identity: storyFingerprint({ reviews: ['a', 'b'], baseStory: 'saved' }), readAt: 1_793_000_000_000,
    drafts: { [SOURCE]: { narrative: 'The checked first batch.', preferences: [preference()] } } } });

function fixture(run: (path: string, dir: string) => void): void {
  const dir = fs.mkdtempSync(join(tmpdir(), 'story-cache-'));
  try { run(join(dir, 'story-preferences', 'state.json'), dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function expectRefused(run: () => unknown): void {
  let failure: unknown;
  try { run(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ retryable: false, answerRefused: true });
}

describe('canonical story preference identities', () => {
  it('preserves every character of the model-selected key, including surrounding whitespace', () => {
    const normalized = validateCanonicalPreferenceKey({ action: '  USE\n', target: 'CAFE\u0301\t Names ', condition: ' BEFORE\nShipping  ', polarity: 'require' });
    expect(normalized).toEqual({ action: '  USE\n', target: 'CAFE\u0301\t Names ', condition: ' BEFORE\nShipping  ', polarity: 'require' });
    expect(storyFingerprint(normalized)).not.toBe(storyFingerprint({ ...normalized, polarity: 'avoid' }));
    expect(storyFingerprint(normalized)).not.toBe(storyFingerprint({ ...normalized, condition: '' }));
  });

  it('preserves case-sensitive targets and identifiers in every key field', () => {
    const base = { action: 'use', target: 'TEST.md', condition: 'when Foo exists', polarity: 'require' as const };
    const identity = storyFingerprint(validateCanonicalPreferenceKey(base));
    for (const different of [{ ...base, target: 'test.md' }, { ...base, condition: 'when foo exists' }, { ...base, action: 'USE' }]) {
      expect(storyFingerprint(validateCanonicalPreferenceKey(different))).not.toBe(identity);
    }
  });

  it('keeps internal spaces and different Unicode forms distinct in every key field', () => {
    for (const field of ['action', 'target', 'condition']) {
      const base = { action: 'read', target: 'literal', condition: '', polarity: 'require' as const };
      for (const [first, second] of [['a  b.txt', 'a b.txt'], ['café.txt', 'cafe\u0301.txt'], ['a.txt', ' a.txt ']]) {
        expect(storyFingerprint(validateCanonicalPreferenceKey({ ...base, [field]: first })))
          .not.toBe(storyFingerprint(validateCanonicalPreferenceKey({ ...base, [field]: second })));
      }
    }
  });

  it.each([
    null,
    { action: 'run', target: 'tests', condition: '', polarity: 'require', extra: 'guess' },
    { action: ' ', target: 'tests', condition: '', polarity: 'require' },
    { action: 'run', target: '', condition: '', polarity: 'require' },
    { action: 'run', target: 'tests', polarity: 'require' },
    { action: 'run', target: 'tests', condition: '', polarity: 'maybe' },
    { action: 'x'.repeat(500), target: 'tests', condition: '', polarity: 'require' },
  ])('rejects an incomplete or ambiguous preference key: %j', value => {
    expect(() => validateCanonicalPreferenceKey(value)).toThrow(TypeError);
  });

  it('fingerprints reordered nested objects identically but preserves every field and array order', () => {
    expect(storyFingerprint({ b: [2, 1], a: { y: 2, x: 1 } })).toBe(storyFingerprint({ a: { x: 1, y: 2 }, b: [2, 1] }));
    expect(storyFingerprint({ ids: ['a', 'b'] })).not.toBe(storyFingerprint({ ids: ['b', 'a'] }));
    expect(storyFingerprint(JSON.parse('{"__proto__":{"value":"source"}}'))).not.toBe(storyFingerprint({}));
    expect(storyFingerprint({ quote: 'Original' })).not.toBe(storyFingerprint({ quote: 'Edited' }));
    expect(storyFingerprint('1')).not.toBe(storyFingerprint(1));
  });

  it('does not silently fingerprint non-JSON values or cyclic source state', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const value of [undefined, { missing: undefined }, { value: Infinity }, new Map(), cycle]) {
      expect(() => storyFingerprint(value)).toThrow(TypeError);
    }
  });
});

describe('private checked story cache', () => {
  it('returns fresh state for a missing file without creating work or storage', () => fixture(path => {
    expect(readStoryCache(path, CONTEXT)).toEqual({ version: 1, context: CONTEXT, canonical: {}, proofs: [] });
    expect(fs.existsSync(path)).toBe(false);
  }));

  it('round-trips checked answers, provenance and narrative progress atomically with private permissions', () => fixture(path => {
    const before = state();
    writeStoryCache(path, before);
    expect(readStoryCache(path, CONTEXT)).toEqual(before);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    }
    const next = state(); next.checkpoint!.drafts[SOURCE].narrative = 'The next complete draft.';
    writeStoryCache(path, next);
    expect(readStoryCache(path, CONTEXT)).toEqual(next);
    expect(fs.readdirSync(join(path, '..'))).toEqual(['state.json']);
    expect(before.checkpoint!.drafts[SOURCE].narrative).toBe('The checked first batch.');
  }));

  it('context changes discard inference results while retaining committed provenance', () => fixture(path => {
    const before = state();
    before.proofs.push({ storyHash: storyFingerprint('prospective'), preferences: [{ preference: preference(), requestIds: [], legacySupportCount: 2 }] });
    writeStoryCache(path, before);
    const bytes = fs.readFileSync(path, 'utf8');
    const changed = storyFingerprint({ device: 'other', model: 'new-model', prompt: 'canonical-v2' });
    expect(readStoryCache(path, changed)).toEqual({ version: 1, context: changed, canonical: {}, proofs: before.proofs });
    expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
  }));

  it('retains 10,000 distinct request identities privately without the shared-story value cap', () => fixture(path => {
    const before = state();
    before.proofs[0].preferences[0].requestIds = Array.from({ length: 10_000 }, (_, index) => `g_${index.toString(16).padStart(12, '0')}`);
    before.proofs[0].preferences[0].preference.supportCount = 10_000;
    writeStoryCache(path, before);
    expect(fs.statSync(path).size).toBeGreaterThan(48_000);
    expect(readStoryCache(path, CONTEXT).proofs[0].preferences[0].requestIds).toEqual(before.proofs[0].preferences[0].requestIds);
    expect(fs.existsSync(join(path, '..', '..', 'story.json'))).toBe(false);
  }));

  it.each([
    ['version', (value: any) => { value.version = 2; }],
    ['unknown field', (value: any) => { value.pending = ['unanswered']; }],
    ['canonical source key', (value: any) => { value.canonical = { page1: key() }; }],
    ['non-string canonical answer', (value: any) => { value.canonical[SOURCE].action = 42; }],
    ['proof hash', (value: any) => { value.proofs[0].storyHash = 'page1'; }],
    ['duplicate proof', (value: any) => { value.proofs.push(value.proofs[0]); }],
    ['too many proofs', (value: any) => { value.proofs = [1, 2, 3].map(id => ({ ...value.proofs[0], storyHash: storyFingerprint(id) })); }],
    ['duplicate requests', (value: any) => { value.proofs[0].preferences[0].requestIds = ['same', 'same']; }],
    ['non-string requests', (value: any) => { value.proofs[0].preferences[0].requestIds = [42]; }],
    ['empty request', (value: any) => { value.proofs[0].preferences[0].requestIds = [' ']; }],
    ['legacy count', (value: any) => { value.proofs[0].preferences[0].legacySupportCount = -1; }],
    ['unexplained support count', (value: any) => { value.proofs[0].preferences[0].preference.supportCount = 3; }],
    ['missing known requests', (value: any) => { value.proofs[0].preferences[0].requestIds = []; }],
    ['unvalidated proof preference', (value: any) => { value.proofs[0].preferences[0].preference = { preference: 'Missing checked defaults' }; }],
    ['checkpoint identity', (value: any) => { value.checkpoint.identity = 'offset-1'; }],
    ['checkpoint time', (value: any) => { value.checkpoint.readAt = -1; }],
    ['checkpoint source key', (value: any) => { value.checkpoint.drafts = { page1: value.checkpoint.drafts[SOURCE] }; }],
    ['unvalidated draft', (value: any) => { value.checkpoint.drafts[SOURCE].preferences[0].supportCount = 0; }],
  ] as const)('refuses corrupt %s even when the context changed, preserving the stored file', (_name, corrupt) => fixture(path => {
    const bad = state(); corrupt(bad);
    fs.mkdirSync(join(path, '..'), { recursive: true });
    const bytes = JSON.stringify(bad);
    fs.writeFileSync(path, bytes);
    expectRefused(() => readStoryCache(path, 'different-context'));
    expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
  }));

  it('refuses unreadable JSON without replacing it or interpreting it as a fresh cache', () => fixture(path => {
    fs.mkdirSync(join(path, '..'), { recursive: true });
    fs.writeFileSync(path, '{incomplete');
    expectRefused(() => readStoryCache(path, CONTEXT));
    expect(fs.readFileSync(path, 'utf8')).toBe('{incomplete');
  }));

  it('does not replace durable progress with an invalid new state', () => fixture(path => {
    const before = state(); writeStoryCache(path, before);
    const bad = state(); bad.proofs[0].preferences[0].requestIds.push('request-a');
    expectRefused(() => writeStoryCache(path, bad));
    expect(readStoryCache(path, CONTEXT)).toEqual(before);
    expect(fs.readdirSync(join(path, '..'))).toEqual(['state.json']);
  }));

  it('rejects sparse proof and draft arrays before serialization can turn holes into null', () => fixture(path => {
    const before = state(); writeStoryCache(path, before);
    for (const corrupt of [
      (value: StoryCache) => { delete value.proofs[0]; },
      (value: StoryCache) => { delete value.proofs[0].preferences[0]; },
      (value: StoryCache) => { delete value.proofs[0].preferences[0].requestIds[0]; },
      (value: StoryCache) => { delete value.checkpoint!.drafts[SOURCE].preferences[0]; },
    ]) {
      const bad = state(); corrupt(bad);
      expectRefused(() => writeStoryCache(path, bad));
      expect(readStoryCache(path, CONTEXT)).toEqual(before);
    }
  }));

  it('a failed rename preserves the prior state and removes only this write’s temporary file', () => fixture(path => {
    const before = state(); writeStoryCache(path, before);
    const unrelated = path + '.another-writer.tmp'; fs.writeFileSync(unrelated, 'unfinished');
    const next = state(); next.checkpoint!.drafts[SOURCE].narrative = 'Not committed.';
    const rename = fs.renameSync;
    const failure = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === path) throw new Error('Synthetic rename failure');
      return rename(from, to);
    });
    try { expectRefused(() => writeStoryCache(path, next)); }
    finally { failure.mockRestore(); }
    expect(readStoryCache(path, CONTEXT)).toEqual(before);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('unfinished');
    expect(fs.readdirSync(join(path, '..')).sort()).toEqual(['state.json', 'state.json.another-writer.tmp']);
    expect(next.checkpoint!.drafts[SOURCE].narrative).toBe('Not committed.');
  }));

  it('does not replace durable progress when syncing the new file fails', () => fixture(path => {
    const before = state(); writeStoryCache(path, before);
    const next = state(); next.checkpoint!.drafts[SOURCE].narrative = 'Unsynced result.';
    const failure = spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('Synthetic sync failure'); });
    try { expectRefused(() => writeStoryCache(path, next)); }
    finally { failure.mockRestore(); }
    expect(readStoryCache(path, CONTEXT)).toEqual(before);
    expect(fs.readdirSync(join(path, '..'))).toEqual(['state.json']);
  }));
});
