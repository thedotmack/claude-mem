import test from 'node:test';
import assert from 'node:assert/strict';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import mode from '../../plugin/modes/code.json' with { type: 'json' };

ModeManager.getInstance().useModeSnapshot({ ...mode, id: 'code' });
const formatter = new FormattingService();
const observation = { id: 1, type: 'bugfix', created_at_epoch: 1000, title: 'First\r\nSecond\nThird\rFourth\u2028Fifth\u2029Last' };
const session = { id: 2, created_at_epoch: 1000, request: observation.title };
const prompt = { id: 3, created_at_epoch: 1000, prompt_text: observation.title };

for (const [name, format] of [
  ['observation index', () => formatter.formatObservationIndex(observation, 0)],
  ['session index', () => formatter.formatSessionIndex(session, 0)],
  ['prompt index', () => formatter.formatUserPromptIndex(prompt, 0)],
  ['observation search', () => formatter.formatObservationSearchRow(observation, '').row],
  ['session search', () => formatter.formatSessionSearchRow(session, '').row],
  ['prompt search', () => formatter.formatUserPromptSearchRow(prompt, '').row],
]) test(name + ' keeps multiline captured text in one Markdown row', () => {
  const row = format();
  assert.doesNotMatch(row, /[\r\n\u2028\u2029]/);
  assert.ok(row.includes('First Second Third Fourth Fifth Last'));
  assert.ok(row.startsWith('| #'));
});

test('prompt truncation counts the normalized title and preserves stored text', () => {
  const prompt_text = 'a'.repeat(30) + '\r\n' + 'b'.repeat(29);
  const row = formatter.formatUserPromptIndex({ ...prompt, prompt_text }, 0);
  assert.ok(row.includes('a'.repeat(30) + ' ' + 'b'.repeat(29)));
  assert.ok(!row.includes('...'));
  assert.equal(prompt_text.length, 61);
});

test('timeline keeps the complete multiline observation title and anchor in one table row', async () => {
  const stored = Object.freeze({ ...observation, project: 'timeline-lines', narrative: 'Some context' });
  const store = {
    getProjectReadKeys: keys => keys,
    getObservationsByIds: () => [stored],
    getTimelineAroundObservation: () => ({ observations: [stored] }),
  };
  const manager = new SearchManager({}, store, null, formatter, new TimelineService());
  const response = await manager.timeline({ anchor: stored.id, depth_before: 0, depth_after: 0 });

  assert.notEqual(response.isError, true);
  const rows = response.content[0].text.split(/[\r\n\u2028\u2029]+/).filter(line => line.startsWith('| #'));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].includes('First Second Third Fourth Fifth Last <- **ANCHOR**'));
  assert.match(rows[0], /\| ~\d+ \|$/);
  assert.equal(stored.title, observation.title);
});
