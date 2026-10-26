import { describe, expect, it } from 'bun:test';
import { extractTranscriptFileActivityFromJsonl } from '../../src/shared/deliverables-transcript.js';

const user = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
const assistant = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-26T20:00:00.000Z', message: { role: 'assistant', content }, ...extra });
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, isError = false) => ({ type: 'tool_result', tool_use_id: id, content: isError ? 'failed' : 'ok', ...(isError ? { is_error: true } : {}) });

const TRANSCRIPT = [
  user('Write the launch report'),
  assistant([toolUse('toolu_1', 'Write', { file_path: '/w/.scratch/old.html', content: 'x' })]),
  user([toolResult('toolu_1')]),
  user('Now a deck too'),
  assistant([toolUse('toolu_2', 'Write', { file_path: '/w/.scratch/report.html', content: 'v1' })]),
  user([toolResult('toolu_2')]),
  assistant([toolUse('toolu_3', 'Edit', { file_path: '/w/.scratch/report.html', old_string: 'v1', new_string: 'v2' })]),
  user([toolResult('toolu_3')]),
  assistant([toolUse('toolu_4', 'Write', { file_path: '/w/.scratch/broken.pdf', content: '' })]),
  user([toolResult('toolu_4', true)]),
  assistant([toolUse('toolu_5', 'mcp__plugin_claude-mem_mcp-search__work_state_write', { list: 'launch', fields: { task: 'deck', status: 'done', work_product: '/w/.scratch/deck.pdf' } })]),
  user([toolResult('toolu_5')]),
  JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [toolUse('toolu_6', 'Write', { file_path: '/w/.scratch/side.png' })] } }),
  'not json at all',
  assistant([toolUse('toolu_7', 'NotebookEdit', { notebook_path: '/w/analysis.ipynb', new_source: '' })]),
  assistant([{ type: 'text', text: 'Done.' }]),
].join('\n');

describe('extractTranscriptFileActivityFromJsonl', () => {
  it('returns the final turn\'s writes, one per path with its last tool, and its work-state writes', () => {
    const activity = extractTranscriptFileActivityFromJsonl(TRANSCRIPT);
    expect(activity.writes).toEqual([
      { path: '/w/.scratch/report.html', toolName: 'Edit', toolUseId: 'toolu_3', occurredAtEpoch: Date.parse('2026-10-26T20:00:00.000Z') },
      { path: '/w/analysis.ipynb', toolName: 'NotebookEdit', toolUseId: 'toolu_7', occurredAtEpoch: Date.parse('2026-10-26T20:00:00.000Z') },
    ]);
    expect(activity.workStateWrites).toEqual([
      { list: 'launch', fields: { task: 'deck', status: 'done', work_product: '/w/.scratch/deck.pdf' }, toolUseId: 'toolu_5', occurredAtEpoch: Date.parse('2026-10-26T20:00:00.000Z') },
    ]);
  });

  it('drops a write whose tool result failed and never reads sidechain entries', () => {
    const paths = extractTranscriptFileActivityFromJsonl(TRANSCRIPT, { currentTurnOnly: false }).writes.map(write => write.path);
    expect(paths).not.toContain('/w/.scratch/broken.pdf');
    expect(paths).not.toContain('/w/.scratch/side.png');
  });

  it('scans every turn when asked, which a subagent\'s single-run transcript needs', () => {
    const paths = extractTranscriptFileActivityFromJsonl(TRANSCRIPT, { currentTurnOnly: false }).writes.map(write => write.path);
    expect(paths).toEqual(['/w/.scratch/old.html', '/w/.scratch/report.html', '/w/analysis.ipynb']);
  });

  it('keeps everything in a tail that starts after the turn began', () => {
    const tail = TRANSCRIPT.split('\n').slice(4).join('\n');
    expect(extractTranscriptFileActivityFromJsonl(tail).writes.map(write => write.path)).toEqual(['/w/.scratch/report.html', '/w/analysis.ipynb']);
  });

  it('ignores a work_state_write without a fields object and empty input', () => {
    const content = [assistant([toolUse('toolu_9', 'work_state_write', { list: 'x' })]), ''].join('\n');
    expect(extractTranscriptFileActivityFromJsonl(content)).toEqual({ writes: [], workStateWrites: [] });
    expect(extractTranscriptFileActivityFromJsonl('')).toEqual({ writes: [], workStateWrites: [] });
  });
});
