import { expect, test } from 'bun:test';
import { CorpusBuilder } from '../../../src/services/worker/knowledge/CorpusBuilder.js';
import { CorpusRenderer } from '../../../src/services/worker/knowledge/CorpusRenderer.js';

const row = {
  id: 11, type: 'discovery', title: 'Storage layout', project: 'archive',
  created_at_epoch: 1000, created_at: new Date(1000).toISOString(),
  files_read: '[]', files_modified: '[]',
};

async function build(facts: string, concepts: string) {
  const rows = [{ ...row, facts, concepts }];
  return new CorpusBuilder(
    { getObservationsByIds: () => rows } as any,
    { search: async () => ({ results: { observations: rows } }) } as any,
    { write() {} } as any,
  ).build('archive', '', {}, { writeFile: false });
}

test('keeps plain legacy facts and concepts in knowledge context', async () => {
  const corpus = await build('检查点保存在独立目录', '恢复流程');
  expect(corpus.observations[0].facts).toEqual(['检查点保存在独立目录']);
  expect(corpus.observations[0].concepts).toEqual(['恢复流程']);
  expect(new CorpusRenderer().renderCorpus(corpus)).toContain('检查点保存在独立目录');
});

test('decodes JSON-string legacy facts and concepts without losing evidence', async () => {
  const corpus = await build(JSON.stringify('The checkpoint is durable.'), JSON.stringify('recovery'));
  expect(corpus.observations[0].facts).toEqual(['The checkpoint is durable.']);
  expect(corpus.observations[0].concepts).toEqual(['recovery']);
});

test('keeps structured list entries and excludes blank or non-string items', async () => {
  const corpus = await build('["first", "", "  ", null, 12, "second"]', '["recovery"]');
  expect(corpus.observations[0].facts).toEqual(['first', 'second']);
  expect(corpus.observations[0].concepts).toEqual(['recovery']);
});
