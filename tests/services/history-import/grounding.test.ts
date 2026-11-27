import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import type { ModeConfig } from '../../../src/services/domain/types.js';
import { historicalObserverInstructions, isFlowOnlyMessage, observationsFromReply } from '../../../src/services/history-import/replay.js';

afterEach(() => mock.restore());

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

test('requires current source evidence for every block and omits the proof excerpt from persisted fields', () => {
  spyOn(ModeManager.getInstance(), 'getActiveMode').mockReturnValue(mode);
  const result = observationsFromReply(xml(quote), passage);
  expect(result).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(passage);
  expect(observationsFromReply(xml(quote) + xml(''), passage)).toBeNull();
  expect(observationsFromReply(xml(quote), mode.name)).toBeNull();
  expect(observationsFromReply(xml(quote), passage, mode.name)).toBeNull();
  expect(observationsFromReply(xml(quote + quote), passage)).toBeNull();
  expect(observationsFromReply('<skip_summary reason="noise" />', passage)).toEqual([]);
  expect(observationsFromReply('<skip/>', passage)).toEqual([]);
});
