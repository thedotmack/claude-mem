import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractTranscriptFileActivity, extractTranscriptFileActivityFromJsonl, isPrivatePrompt } from '../../src/shared/deliverables-transcript.js';

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

  it('drops a write whose tool result failed and leaves a session transcript\'s sidechain entries to SubagentStop', () => {
    const paths = extractTranscriptFileActivityFromJsonl(TRANSCRIPT, { currentTurnOnly: false }).writes.map(write => write.path);
    expect(paths).not.toContain('/w/.scratch/broken.pdf');
    expect(paths).not.toContain('/w/.scratch/side.png');
  });

  it('reads sidechain entries when asked, which a subagent\'s own transcript needs: every entry in it is one', () => {
    // The shape of ~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl: isSidechain on every line.
    const subagent = [
      JSON.stringify({ type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: 'Write the launch deck' } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, agentId: 'a1', timestamp: '2026-10-26T20:00:00.000Z', message: { role: 'assistant', content: [toolUse('toolu_s1', 'Write', { file_path: '/w/.scratch/deck.html', content: '' })] } }),
      JSON.stringify({ type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: [toolResult('toolu_s1')] } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, agentId: 'a1', timestamp: '2026-10-26T20:00:01.000Z', message: { role: 'assistant', content: [toolUse('toolu_s2', 'mcp__plugin_claude-mem_mcp-search__work_state_write', { list: 'deck', fields: { task: 'deck', status: 'done', work_product: '/w/.scratch/deck.pdf' } })] } }),
      JSON.stringify({ type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: [toolResult('toolu_s2')] } }),
    ].join('\n');
    expect(extractTranscriptFileActivityFromJsonl(subagent, { currentTurnOnly: false })).toMatchObject({ writes: [], workStateWrites: [], promptSeen: false });
    const activity = extractTranscriptFileActivityFromJsonl(subagent, { currentTurnOnly: false, includeSidechain: true });
    expect(activity.writes.map(write => write.path)).toEqual(['/w/.scratch/deck.html']);
    expect(activity.workStateWrites.map(write => write.fields.work_product)).toEqual(['/w/.scratch/deck.pdf']);
    expect(activity.promptSeen).toBe(true);
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
    expect(extractTranscriptFileActivityFromJsonl(content)).toEqual({ writes: [], workStateWrites: [], promptSeen: false, privateTurn: false });
    expect(extractTranscriptFileActivityFromJsonl('')).toEqual({ writes: [], workStateWrites: [], promptSeen: false, privateTurn: false });
  });

  it('marks the turn private when its prompt is entirely <private>, the worker\'s own rule for a stored prompt', () => {
    expect(isPrivatePrompt('<private>plan the layoffs</private>')).toBe(true);
    expect(isPrivatePrompt('  <private>a</private>\n<private>b</private> ')).toBe(true);
    expect(isPrivatePrompt('Write the report <private>for the acquisition</private>')).toBe(false);
    expect(isPrivatePrompt('explain how <private> works')).toBe(false);
    expect(isPrivatePrompt('')).toBe(false);

    const privateTurn = [
      user('Write the launch report'),
      assistant([toolUse('toolu_1', 'Write', { file_path: '/w/.scratch/public.html', content: 'x' })]),
      user([toolResult('toolu_1')]),
      user('<private>Write the severance letters</private>'),
      assistant([toolUse('toolu_2', 'Write', { file_path: '/w/.scratch/letters.html', content: 'x' })]),
      user([toolResult('toolu_2')]),
    ].join('\n');
    const activity = extractTranscriptFileActivityFromJsonl(privateTurn);
    expect(activity).toMatchObject({ promptSeen: true, privateTurn: true });
    expect(activity.writes.map(write => write.path)).toEqual(['/w/.scratch/letters.html']);
    // The earlier, public turn is public.
    expect(extractTranscriptFileActivityFromJsonl(privateTurn.split('\n').slice(0, 3).join('\n')).privateTurn).toBe(false);
    // A prompt that is private in part is not a private turn.
    expect(extractTranscriptFileActivityFromJsonl([user('Write it <private>quietly</private>'), assistant([{ type: 'text', text: 'ok' }])].join('\n')).privateTurn).toBe(false);
  });

  it('reads further back when the tail starts after the turn\'s prompt, so the prompt decides privacy even for a long turn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-transcript-tail-'));
    try {
      const transcriptPath = join(dir, 'session.jsonl');
      const filler = 'x'.repeat(4096);
      const lines = [
        user('Write the launch report'),
        assistant([toolUse('toolu_1', 'Write', { file_path: '/w/.scratch/public.html', content: filler })]),
        user([toolResult('toolu_1')]),
        user('<private>Write the severance letters</private>'),
        assistant([toolUse('toolu_2', 'Write', { file_path: '/w/.scratch/letters.html', content: filler })]),
        user([toolResult('toolu_2')]),
        assistant([toolUse('toolu_3', 'Write', { file_path: '/w/.scratch/more.html', content: filler })]),
        user([toolResult('toolu_3')]),
        assistant([{ type: 'text', text: 'Done.' }]),
        '',
      ];
      writeFileSync(transcriptPath, lines.join('\n'));
      // A 1 KiB first read sees only the last entries; the prompt is found by widening, and the turn's every write is kept.
      const activity = extractTranscriptFileActivity(transcriptPath, { maxTailBytes: 1024 });
      expect(activity).toMatchObject({ promptSeen: true, privateTurn: true });
      expect(activity.writes.map(write => write.path)).toEqual(['/w/.scratch/letters.html', '/w/.scratch/more.html']);
      // A whole-transcript scan (a subagent's own file) takes the tail as given.
      expect(extractTranscriptFileActivity(transcriptPath, { maxTailBytes: 1024, currentTurnOnly: false }).promptSeen).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
