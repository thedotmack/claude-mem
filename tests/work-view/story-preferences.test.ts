import { describe, expect, it } from 'bun:test';
import { boundedStoryPreferences, STORY_INPUT_BYTES, storyPreferenceEvidence, type PreferenceEvidence } from '../../src/services/work-view/story-batches.js';
import { storyFingerprint, type CanonicalPreferenceKey, type PreferenceProvenance } from '../../src/services/work-view/story-cache.js';
import { storyInput } from '../../src/services/work-view/request-groups.mjs';

const key = (target: string, condition = '', polarity: 'require' | 'avoid' = 'require'): CanonicalPreferenceKey => ({ action: 'check', target, condition, polarity });
const value = (preference: string, quote = `Original quote: ${preference}`) => ({ preference, kind: 'directive', quote, at: null });
const source = (preferences: Array<Record<string, any>> = []) => storyInput(0, [], preferences.length
  ? { narrative: 'Saved story.', preferences, writtenAt: '2026-11-17T00:00:00.000Z' } : null);
const originalStory = (preference = 'Keep changes focused.', supportCount = 3) => ({ preference, kind: 'directive', supportCount,
  quotes: [{ quote: 'One concern per change.', at: null }] });

describe('bounded canonical story preferences', () => {
  it('processes 1100 requests with 10 distinct preferences in 172 complete pages', async () => {
    const values: PreferenceEvidence['values'] = [], requests: PreferenceEvidence['requests'] = [];
    for (let request = 0; request < 1100; request++) {
      const preferences: number[] = [];
      for (let index = 0; index < 10; index++) {
        preferences.push(values.length);
        values.push(value(`Preference ${request}:${index}`, `完整原始引文 ${request}:${index}`));
      }
      requests.push({ groupId: `request-${request}`, preferences });
    }
    const seen = new Set<number>();
    let calls = 0;
    const result = await boundedStoryPreferences(source(), { values, requests }, async (input, validate) => {
      calls++;
      expect(input.values.length).toBeLessThanOrEqual(64);
      expect(Buffer.byteLength(JSON.stringify(input, null, 2), 'utf8')).toBeLessThanOrEqual(STORY_INPUT_BYTES);
      for (const item of input.values) {
        expect(seen.has(item.id)).toBe(false);
        expect(item.evidence).toEqual(values[item.id]);
        seen.add(item.id);
      }
      return validate({ assignments: input.values.map(item => ({ id: item.id, key: key(item.evidence.preference) })) });
    });
    expect(calls).toBe(Math.ceil(11000 / 64));
    expect(seen.size).toBe(11000);
    expect(result).toEqual({ preferences: [], provenance: [] });
  });

  it('counts 1100 distinct requests for a shared preference without exposing private proof', async () => {
    const values = Array.from({ length: 1100 }, (_, id) => value(`Check the tests, wording ${id}.`, `Request ${id}: run the tests.`));
    const requests = values.map((_, id) => ({ groupId: `request-${id}`, preferences: [id] }));
    let calls = 0;
    const result = await boundedStoryPreferences(source(), { values, requests }, async (input, validate) => {
      calls++;
      return validate({ assignments: input.values.map(item => ({ id: item.id, key: key('tests') })) });
    });
    expect(calls).toBe(Math.ceil(1100 / 64));
    expect(result.preferences).toEqual([{ preference: values[0].preference, kind: 'directive', supportCount: 1100,
      quotes: values.slice(0, 3).map(item => ({ quote: item.quote, at: null })) }]);
    expect(result.provenance[0].requestIds).toHaveLength(1100);
    expect(Object.keys(result.preferences[0]).sort()).toEqual(['kind', 'preference', 'quotes', 'supportCount']);
    expect(result.provenance[0].preference).toEqual(result.preferences[0]);
  });

  it('interns exact shared evidence without losing any of its 1100 request votes', async () => {
    const shared = value('Run the tests.');
    const input = storyInput(1100, Array.from({ length: 1100 }, (_, id) => ({ groupId: `request-${id}`, preferences: [shared, shared] })), null);
    const evidence = storyPreferenceEvidence(input);
    expect(evidence.values).toEqual([shared]);
    expect(evidence.requests).toHaveLength(1100);
    let calls = 0;
    const result = await boundedStoryPreferences(input, evidence, async (batch, validate) => {
      calls++;
      return validate({ assignments: batch.values.map(item => ({ id: item.id, key: key('tests') })) });
    });
    expect(calls).toBe(1);
    expect(result.preferences[0].supportCount).toBe(1100);
  });

  it('joins first, middle and last page synonyms while counting their shared request only once', async () => {
    const values = Array.from({ length: 257 }, (_, id) => value(`Preference ${id}`));
    values[0] = value('Run tests before committing.');
    values[128] = value('Verify tests before each commit.');
    values[256] = value('Commit only after tests pass.');
    const requests = values.map((_, id) => ({ groupId: id === 0 || id === 128 ? 'same-request' : `request-${id}`, preferences: [id] }));
    const pages: number[][] = [];
    const result = await boundedStoryPreferences(source(), { values, requests }, async (input, validate) => {
      pages.push(input.values.map(item => item.id));
      return validate({ assignments: input.values.map(item => ({ id: item.id,
        key: [0, 128, 256].includes(item.id) ? key('tests', 'before committing') : key(item.evidence.preference) })) });
    });
    expect(pages).toHaveLength(5);
    expect(pages.filter(page => page.some(id => [0, 128, 256].includes(id)))).toHaveLength(3);
    expect(result.preferences).toEqual([{ preference: values[0].preference, kind: 'directive', supportCount: 2,
      quotes: [0, 128, 256].map(id => ({ quote: values[id].quote, at: null })) }]);
    expect(result.provenance[0].requestIds).toEqual(['request-256', 'same-request']);
  });

  it('keeps conditional, unconditional and negated instructions separate', async () => {
    const instructions = [
      { text: 'Check deployments.', canonical: key('deployments') },
      { text: 'Check deployments in production.', canonical: key('deployments', 'in production') },
      { text: 'Avoid checking deployments.', canonical: key('deployments', '', 'avoid') },
      { text: 'Avoid checking deployments in production.', canonical: key('deployments', 'in production', 'avoid') },
    ];
    const values = instructions.map(instruction => value(instruction.text));
    const requests = values.flatMap((_, id) => [0, 1].map(vote => ({ groupId: `${id}-${vote}`, preferences: [id] })));
    const result = await boundedStoryPreferences(source(), { values, requests }, async (input, validate) => validate({
      assignments: input.values.map(item => ({ id: item.id, key: instructions[item.id].canonical })),
    }));
    expect(result.preferences.map(preference => preference.preference)).toEqual(instructions.map(instruction => instruction.text));
    expect(result.preferences.every(preference => preference.supportCount === 2)).toBe(true);
  });

  it('does not collapse case, internal spaces or Unicode spelling in concrete targets', async () => {
    const targets = ['TEST.md', 'test.md', 'a  b.txt', 'a b.txt', 'caf\u00e9.txt', 'cafe\u0301.txt'];
    const values = targets.map(target => value(`Check exactly ${target}`));
    const requests = values.flatMap((_, id) => [0, 1].map(vote => ({ groupId: `${id}-${vote}`, preferences: [id] })));
    const result = await boundedStoryPreferences(source(), { values, requests }, async (input, validate) => validate({
      assignments: input.values.map(item => ({ id: item.id, key: key(targets[item.id]) })),
    }));
    expect(result.preferences.map(preference => preference.preference)).toEqual(values.map(item => item.preference));
    expect(result.preferences.every(preference => preference.supportCount === 2)).toBe(true);
  });

  it('retains a singleton in the complete source and lets it overtake the thirtieth preference later', async () => {
    const values: PreferenceEvidence['values'] = [], requests: PreferenceEvidence['requests'] = [];
    for (let preference = 0; preference < 31; preference++) for (let vote = 0; vote < (preference === 30 ? 1 : 2); vote++) {
      requests.push({ groupId: `${preference}-${vote}`, preferences: [values.length] });
      values.push(value(`Preference ${preference}`, `Evidence ${preference}-${vote}`));
    }
    let cache: Record<string, CanonicalPreferenceKey> = {};
    const canonicalize = async (input: any, validate: any) => validate({ assignments: input.values.map((item: any) => ({ id: item.id, key: key(item.evidence.preference) })) });
    const first = await boundedStoryPreferences(source(), { values, requests }, canonicalize, { saveCanonical: entries => { cache = entries; } });
    expect(first.preferences).toHaveLength(30);
    expect(first.preferences.some(preference => preference.preference === 'Preference 30')).toBe(false);
    expect(Object.hasOwn(cache, storyFingerprint(values.at(-1)))).toBe(true);
    const unchanged = new Set(values.map(preference => storyFingerprint(preference)));
    for (let vote = 1; vote <= 2; vote++) {
      requests.push({ groupId: `30-${vote}`, preferences: [values.length] });
      values.push(value('Preference 30', `Evidence 30-${vote}`));
    }
    const second = await boundedStoryPreferences(source(first.preferences), { values, requests }, async (input, validate) => {
      expect(input.values.some(item => unchanged.has(storyFingerprint(item.evidence)))).toBe(false);
      return canonicalize(input, validate);
    }, { canonical: cache, saveCanonical: entries => { cache = entries; }, previous: first.provenance });
    expect(second.preferences[0].preference).toBe('Preference 30');
    expect(second.preferences[0].supportCount).toBe(3);
    expect(second.preferences).toHaveLength(30);
    expect(second.provenance.map(proof => proof.preference)).toEqual(second.preferences);
    expect(second.provenance[0].requestIds).toEqual(['30-0', '30-1', '30-2']);
  });

  it('adds genuinely new request ids to saved support and never adds re-reviewed ids twice', async () => {
    const saved = originalStory();
    const previous: PreferenceProvenance[] = [{ preference: saved, requestIds: ['a', 'b', 'c'] }];
    const resolve = async (ids: string[]) => boundedStoryPreferences(source([saved]), {
      values: [value('Make every change focused.')], requests: ids.map(groupId => ({ groupId, preferences: [0, 0] })),
    }, async (input, validate) => validate({ assignments: input.values.map(item => ({ id: item.id, key: key('focused changes') })) }), { previous });
    const added = await resolve(['d', 'e']);
    expect(added.preferences[0].supportCount).toBe(5);
    expect(added.provenance[0].requestIds).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(added.provenance[0].legacySupportCount).toBeUndefined();
    const repeated = await resolve(['a', 'b']);
    expect(repeated.preferences[0].supportCount).toBe(3);
    expect(repeated.provenance[0].requestIds).toEqual(['a', 'b', 'c']);
    expect(added.preferences[0].preference).toBe(saved.preference);
    expect(added.preferences[0].quotes[0]).toEqual(saved.quotes[0]);
  });

  it('replaces a reviewed request vote, including withdrawal of all its preferences', async () => {
    const saved = originalStory();
    const previous = [{ preference: saved, requestIds: ['a', 'b', 'c'] }];
    const input = storyInput(3, [
      { groupId: 'a', preferences: [] },
      { groupId: 'b', preferences: [value('Keep every deployment private.')] },
    ], source([saved]).previousStory);
    const evidence = storyPreferenceEvidence(input);
    expect(evidence.requests).toEqual([{ groupId: 'a', preferences: [] }, { groupId: 'b', preferences: [0] }]);
    const result = await boundedStoryPreferences(input, evidence, async (batch, validate) => validate({
      assignments: batch.values.map(item => ({ id: item.id, key: key(item.evidence.preference) })),
    }), { previous });
    expect(result.preferences[0].supportCount).toBe(1);
    expect(result.provenance[0].requestIds).toEqual(['c']);
    const withdrawn = await boundedStoryPreferences(source([saved]), { values: [], requests: ['a', 'b', 'c'].map(groupId => ({ groupId, preferences: [] })) },
      async (batch, validate) => validate({ assignments: batch.values.map(item => ({ id: item.id, key: key('focused changes') })) }), { previous });
    expect(withdrawn).toEqual({ preferences: [], provenance: [] });
  });

  it('matches saved proof by the whole preference and records an explicit legacy lower bound otherwise', async () => {
    const saved = originalStory();
    const result = await boundedStoryPreferences(source([saved]), {
      values: [value('Make every change focused.')], requests: ['d', 'e'].map(groupId => ({ groupId, preferences: [0] })),
    }, async (input, validate) => validate({ assignments: input.values.map(item => ({ id: item.id, key: key('focused changes') })) }), {
      previous: [{ preference: { ...saved, supportCount: 2 }, requestIds: ['a', 'b', 'c'] }],
    });
    expect(result.preferences[0].supportCount).toBe(3);
    expect(result.provenance[0].requestIds).toEqual(['d', 'e']);
    expect(result.provenance[0].legacySupportCount).toBe(3);
  });

  it('resumes after a later model failure without paying for the completed page again', async () => {
    const values = Array.from({ length: 130 }, (_, id) => value(`Preference ${id}`));
    const evidence = { values, requests: values.map((_, id) => ({ groupId: `request-${id}`, preferences: [id] })) };
    let cache: Record<string, CanonicalPreferenceKey> = {};
    let calls = 0;
    await expect(boundedStoryPreferences(source(), evidence, async (input, validate) => {
      if (++calls === 2) throw new Error('Provider stopped');
      return validate({ assignments: input.values.map(item => ({ id: item.id, key: key(item.evidence.preference) })) });
    }, { saveCanonical: entries => { cache = entries; } })).rejects.toThrow('Provider stopped');
    expect(Object.keys(cache)).toHaveLength(64);
    const resumed: number[] = [];
    const result = await boundedStoryPreferences(source(), evidence, async (input, validate) => {
      resumed.push(...input.values.map(item => item.id));
      return validate({ assignments: input.values.map(item => ({ id: item.id, key: key(item.evidence.preference) })) });
    }, { canonical: cache, saveCanonical: entries => { cache = entries; } });
    expect(resumed).toEqual(Array.from({ length: 66 }, (_, id) => id + 64));
    expect(Object.keys(cache)).toHaveLength(130);
    expect(result.preferences).toEqual([]);
    const replay = await boundedStoryPreferences(source(), evidence, async () => { throw new Error('Unexpected repeated call'); }, { canonical: cache });
    expect(replay).toEqual(result);
  });

  it('does not mark a checked page complete when its checkpoint write fails', async () => {
    const canonical: Record<string, CanonicalPreferenceKey> = {};
    const evidence = { values: [value('Run tests.')], requests: [{ groupId: 'a', preferences: [0] }] };
    await expect(boundedStoryPreferences(source(), evidence, async (input, validate) => validate({
      assignments: input.values.map(item => ({ id: item.id, key: key('tests') })),
    }), { canonical, saveCanonical: () => { throw new Error('Disk write failed'); } })).rejects.toThrow('Disk write failed');
    expect(canonical).toEqual({});
  });

  it.each(['missing', 'duplicate', 'unknown', 'invalid-key'] as const)('rejects %s assignments without storing them', async invalid => {
    const evidence = { values: [value('Run tests.'), value('Check tests.')], requests: [{ groupId: 'a', preferences: [0, 1] }] };
    let saved = false;
    await expect(boundedStoryPreferences(source(), evidence, async (input, validate) => {
      const assignments: any[] = input.values.map(item => ({ id: item.id, key: key('tests') }));
      if (invalid === 'missing') assignments.pop();
      if (invalid === 'duplicate') assignments.push(assignments[0]);
      if (invalid === 'unknown') assignments[0].id = 99999;
      if (invalid === 'invalid-key') assignments[0].key.polarity = 'sometimes';
      return validate({ assignments });
    }, { saveCanonical: () => { saved = true; } })).rejects.toBeInstanceOf(TypeError);
    expect(saved).toBe(false);
  });

  it('validates returned assignments even if the adapter forgets its validator', async () => {
    await expect(boundedStoryPreferences(source(), { values: [value('Run tests.')], requests: [{ groupId: 'a', preferences: [0] }] },
      async () => [])).rejects.toThrow('missing evidence ids');
  });

  it('shrinks pages by exact UTF-8 bytes without truncating large original quotes', async () => {
    const values = Array.from({ length: 6 }, (_, id) => value(`Preference ${id}`, `${id}-${'据'.repeat(19000)}`));
    let calls = 0, seen = 0;
    await boundedStoryPreferences(source(), { values, requests: values.map((_, id) => ({ groupId: `r${id}`, preferences: [id] })) }, async (input, validate) => {
      calls++;
      expect(Buffer.byteLength(JSON.stringify(input, null, 2), 'utf8')).toBeLessThanOrEqual(STORY_INPUT_BYTES);
      for (const item of input.values) expect(item.evidence.quote).toBe(values[item.id].quote);
      seen += input.values.length;
      return validate({ assignments: input.values.map(item => ({ id: item.id, key: key(item.evidence.preference) })) });
    });
    expect(calls).toBe(2);
    expect(seen).toBe(6);
  });

  it('refuses an indivisible oversized value before any model call or checkpoint', async () => {
    let calls = 0, writes = 0;
    const values = [value('Run tests.'), value('Another preference.', '据'.repeat(STORY_INPUT_BYTES))];
    await expect(boundedStoryPreferences(source(), { values, requests: [{ groupId: 'a', preferences: [0, 1] }] }, async () => {
      calls++;
      return [];
    }, { saveCanonical: () => { writes++; } })).rejects.toThrow('single preference exceeds');
    expect(calls).toBe(0);
    expect(writes).toBe(0);
  });

  it('rejects invalid request references before spending on canonicalization', async () => {
    let called = false;
    await expect(boundedStoryPreferences(source(), { values: [value('Run tests.')], requests: [{ groupId: 'a', preferences: [1] }] }, async () => {
      called = true;
      return [];
    })).rejects.toThrow('unknown evidence index');
    expect(called).toBe(false);
  });
});
