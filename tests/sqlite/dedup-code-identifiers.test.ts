import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { classifyPair } from '../../src/services/dedup/nearDuplicate.js';

const pairs = [
  ['Fixed C++ parser', 'Fixed C parser'],
  ['Fixed C++ parser', 'Fixed C# parser'],
  ['Read src/config.ts', 'Read src config ts'],
  ['Updated user_name field', 'Updated user name field'],
  ['Pinned v1.2 release', 'Pinned v1 2 release'],
  ['Updated src/foo-bar', 'Updated src/foo bar'],
  ['Updated /src/config.ts', 'Updated src/config.ts'],
  ['Updated source-root/config.ts', 'Updated source root/config.ts'],
  ['Updated C:\\src\\foo-bar', 'Updated C:\\src\\foo bar'],
  ['Read .env', 'Read env'],
  ['Updated _private field', 'Updated private field'],
  ['Fixed C++.', 'Fixed C.'],
  ['Fixed C#.', 'Fixed C.'],
  ['Read src/.', 'Read src/..'],
  ['Read src\\.', 'Read src\\..'],
  ['Read .', 'Read ..'],
  ['Read /', 'Read .'],
  ['Fixed C++:', 'Fixed C:'],
  ['Fixed C#:', 'Fixed C:'],
  ['Read C:', 'Read C'],
  ['Updated @field', 'Updated field'],
] as const;
const thresholds = { cosineThreshold: 0.9, vetoThetaIdf: 1 };

function observation(title: string) {
  return { type: 'discovery', title, subtitle: null, facts: [], narrative: title,
    concepts: [], files_read: [], files_modified: [] };
}

describe('exact-title dedup preserves code identifiers', () => {
  let store: SessionStore;
  let previous: string | undefined;
  let sessionNumber = 0;
  beforeEach(() => {
    previous = process.env.CLAUDE_MEM_DEDUP_ENABLED;
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    store = new SessionStore(':memory:');
  });
  afterEach(() => {
    store.close();
    if (previous === undefined) delete process.env.CLAUDE_MEM_DEDUP_ENABLED;
    else process.env.CLAUDE_MEM_DEDUP_ENABLED = previous;
  });

  function save(title: string) {
    const memory = `identifier-${++sessionNumber}`;
    const id = store.createSDKSession(`content-${memory}`, 'p', 'prompt');
    store.updateMemorySessionId(id, memory);
    return store.storeObservation(memory, 'p', observation(title));
  }

  for (const [left, right] of pairs) {
    it(`does not silently merge ${JSON.stringify(left)} into ${JSON.stringify(right)}`, () => {
      const first = save(left);
      const second = save(right);
      expect(second.id).not.toBe(first.id);
      expect(second.mergedIntoExisting).toBe(false);
      expect(store.getObservationById(first.id)?.narrative).toBe(left);
      expect(store.getObservationById(second.id)?.narrative).toBe(right);
      expect(classifyPair(left, right, () => 1, thresholds).tier).not.toBe('exact');
    });
  }

  it('finds the matching canonical row after a different identifier sharing the old key', () => {
    const c = save('Fixed C parser');
    const cpp = save('Fixed C++ parser');
    const repeat = save('FIXED C++ PARSER!');
    expect(cpp.id).not.toBe(c.id);
    expect(repeat.id).toBe(cpp.id);
    expect(repeat.mergedIntoExisting).toBe(true);
  });

  it('still merges case, surrounding punctuation and prose hyphenation variants', () => {
    const first = save('On-Demand Checkpoint.');
    expect(save('on demand checkpoint').id).toBe(first.id);
    const code = save('Fixed C++ parser');
    expect(save('**FIXED C++ PARSER!**').id).toBe(code.id);
    expect(classifyPair('On-Demand Checkpoint.', 'on demand checkpoint', () => 1, thresholds).tier).toBe('exact');
  });

  for (const title of ['Read src/config.ts', 'Fixed C++', 'Read .env', 'Pinned v1.2']) {
    it(`ignores sentence punctuation following ${JSON.stringify(title)}`, () => {
      const first = save(title);
      const repeat = save(`${title}.`);
      expect(repeat.id).toBe(first.id);
      expect(repeat.mergedIntoExisting).toBe(true);
      expect(classifyPair(title, `${title}.`, () => 1, thresholds).tier).toBe('exact');
    });
  }
});
