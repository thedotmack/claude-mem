import { expect, it } from 'bun:test';
import { extractLastAssistantModelFromJsonl, extractLastMessageFromJsonl } from '../../src/shared/transcript-parser.js';

const entry = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Retain this answer.' }], model: 'fixture-model' } });
const noisyTranscript = [entry, '42', '"noise"', '[]', 'null'].join('\n');

it('skips valid JSON non-object records while searching for the last text', () => {
  expect(extractLastMessageFromJsonl(noisyTranscript, 'assistant', false)).toBe('Retain this answer.');
});

it('skips valid JSON non-object records while searching for the observed model', () => {
  expect(extractLastAssistantModelFromJsonl(noisyTranscript)).toBe('fixture-model');
});
