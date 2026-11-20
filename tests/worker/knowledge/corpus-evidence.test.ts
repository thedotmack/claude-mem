import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { CorpusBuilder } from '../../../src/services/worker/knowledge/CorpusBuilder.js';
import { CorpusRenderer } from '../../../src/services/worker/knowledge/CorpusRenderer.js';

async function build(rows: object[]) {
  const builder = new CorpusBuilder(
    { getObservationsByIds: () => rows } as any,
    { search: async () => ({ results: { observations: rows } }) } as any,
    { write() {} } as any,
  );
  return builder.build('investigation', 'Archive', {});
}

const row = { id: 173, type: 'decision', project: 'store', title: 'Same title',
  created_at_epoch: 1000, created_at: new Date(1000).toISOString() };

test('a text-only observation carries its evidence into a knowledge session', async () => {
  const corpus = await build([{ ...row, text: 'Keep the old checkpoint.' },
    { ...row, id: 174, narrative: 'Current narrative', text: 'stale text' }]);
  const rendered = new CorpusRenderer().renderCorpus(corpus);
  assert.match(rendered, /Keep the old checkpoint/);
  assert.match(rendered, /Current narrative/);
  assert.doesNotMatch(rendered, /stale text/);
});

test('equally named observations expose their source identifiers for citation', async () => {
  const corpus = await build([row, { ...row, id: 174 }]);
  const rendered = new CorpusRenderer().renderCorpus(corpus);
  assert.match(rendered, /#173\b/);
  assert.match(rendered, /#174\b/);
});

test('custom mode types count numerically even when an ID names an object property', async () => {
  const corpus = await build([{ ...row, type: 'constructor' }, { ...row, id: 174, type: 'constructor' }]);
  assert.equal(corpus.stats.type_breakdown.constructor, 2);
});
