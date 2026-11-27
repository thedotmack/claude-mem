import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ModeConfig } from '../../../src/services/domain/types.js';
import { historicalObserverInstructions, isFlowOnlyMessage, observationsFromReply, sourcePassages } from '../../../src/services/history-import/replay.js';

const mode: ModeConfig = JSON.parse(readFileSync(new URL('../../../plugin/modes/code.json', import.meta.url), 'utf8'));
// Exercise the reply format on actual repository text, independent of any transcript or model-generated memory.
const passage = mode.prompts.system_identity.split('\n')[0];
const quote = '<source_quote>' + passage + '</source_quote>';
const xml = (support: string) => '<observation>' + support + '<type>discovery</type><title>Mode identity</title></observation>';

test('flow-only matching excludes approvals, qualified requests and questions', () => {
  expect(['continue', 'Go on!', 'Thanks.', 'keep going'].every(isFlowOnlyMessage)).toBe(true);
  expect(['yes', 'approved', 'go ahead', 'continue?', 'continue the migration', 'thanks, deploy the fix'].some(isFlowOnlyMessage)).toBe(false);
});

test('uses the configured ontology and skip policy without technical worked examples', () => {
  const instructions = historicalObserverInstructions(mode);
  expect(instructions).toContain(mode.prompts.skip_guidance);
  for (const type of mode.observation_types) expect(instructions).toContain(type.id);
  expect(instructions).not.toContain('Authentication now supports');
});

test('stores only one verified excerpt and an attributed title, ignoring unsupported fields in model XML', () => {
  const generated = xml(quote).replace('</observation>', '<narrative>unsupported</narrative><facts><fact>unsupported</fact></facts><files_modified><file>unsupported</file></files_modified></observation>');
  const result = observationsFromReply(generated, passage, 'assistant', mode);
  expect(result).toHaveLength(1);
  expect(result![0].title!.startsWith('Assistant said “')).toBe(true);
  expect(result![0]).toMatchObject({ type: 'discovery', facts: [passage], narrative: null, subtitle: null, concepts: [], files_read: [], files_modified: [] });
  expect(JSON.stringify(result)).not.toContain('unsupported');
  expect(JSON.stringify(result)).not.toContain('Mode identity');
  expect(observationsFromReply(xml(quote) + xml(''), passage, 'user', mode)).toBeNull();
  expect(observationsFromReply(xml(quote), mode.name, 'user', mode)).toBeNull();
  expect(observationsFromReply(xml(quote), passage, 'user', mode, mode.name)).toBeNull();
  expect(observationsFromReply(xml(quote + quote), passage, 'user', mode)).toBeNull();
  expect(observationsFromReply(xml(quote).replace('discovery', 'unknown-category'), passage, 'user', mode)).toBeNull();
  expect(observationsFromReply('<skip_summary reason="noise" />', passage, 'user', mode)).toEqual([]);
  expect(observationsFromReply('<skip/>', passage, 'user', mode)).toEqual([]);
});

test('bounds excerpt size and preserves complete graphemes in a shortened title', () => {
  const unicode = 'a'.repeat(75) + '🧑🏽‍💻' + 'bc';
  const obs = observationsFromReply(xml('<source_quote>' + unicode + '</source_quote>'), unicode, 'user', mode);
  expect(obs?.[0].title).toEqual('User said “' + 'a'.repeat(75) + '🧑🏽‍💻…”');
  expect(obs?.[0].facts).toEqual([unicode]);
  const long = passage.repeat(15);
  expect(observationsFromReply(xml('<source_quote>' + long + '</source_quote>'), long, 'user', mode)).toBeNull();
});

test('numbered choices resolve exact current-turn passages and reject other turns and ambiguous references', () => {
  const source = mode.prompts.skip_guidance;
  const choices = sourcePassages(source, source, 7);
  expect(choices.length).toBeGreaterThan(0);
  expect(choices.every(passage => source.includes(passage.text))).toBe(true);
  const ref = (id: string) => '<source_id>' + id + '</source_id>';
  const select = (body: string) => observationsFromReply(xml(body), source, 'user', mode, source, choices);
  expect(select(ref(choices[0].id))?.[0].facts).toEqual([choices[0].text]);
  const repeated = xml(ref(choices[0].id)) + xml(ref(choices[0].id)).replace('discovery', 'decision');
  expect(observationsFromReply(repeated, source, 'user', mode, source, choices)).toHaveLength(1);
  expect(select(ref('T6.1'))).toBeNull();
  expect(select(ref('T7.999'))).toBeNull();
  expect(select(ref(choices[0].id) + quote)).toBeNull();
});

test('a clipped display fragment cannot become a selectable passage', () => {
  const clipped = passage.slice(2, -2);
  expect(sourcePassages(passage, clipped, 1)).toEqual([]);
});
