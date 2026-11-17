import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAdvisorCalls, extractAdvisorCallsFromJsonl } from '../../src/shared/advisor-transcript.js';
import { extractTranscriptFileActivity, extractTranscriptFileActivityFromJsonl } from '../../src/shared/deliverables-transcript.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ingestAdvisorCalls } from '../../src/services/worker/http/shared.js';

const privatePrompt = '<private>Write the confidential report</private>';
const user = (content: unknown, isMeta?: boolean) => JSON.stringify({ type: 'user', isMeta, message: { role: 'user', content } });
const assistant = (content: unknown) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-17T00:00:00Z', message: { role: 'assistant', content } });
const notification = user([{ type: 'text', text: 'Continue checking the background task.' }], true);
const invocation = assistant([
  { type: 'server_tool_use', id: 'advice', name: 'advisor', input: {} },
  { type: 'tool_use', id: 'write', name: 'Write', input: { file_path: '/work/report.md' } },
  { type: 'tool_use', id: 'state', name: 'work_state_write', input: { list: 'report', fields: { status: 'done' } } },
]);
const results = [
  assistant([{ type: 'advisor_tool_result', tool_use_id: 'advice', content: { type: 'advisor_result', text: 'Keep the report confidential.' } }]),
  user(['write', 'state'].map(id => ({ type: 'tool_result', tool_use_id: id, content: 'ok' }))),
];
const transcript = (position: number, prompt = privatePrompt) => {
  const lines = [user(prompt), invocation, ...results];
  lines.splice(position, 0, notification);
  return lines.join('\n');
};

describe('automatic transcript messages retain the originating user turn', () => {
  for (const position of [1, 2, 4]) {
    it(`keeps advice and its originating prompt with a meta message at position ${position}`, () => {
      const calls = extractAdvisorCallsFromJsonl(transcript(position), { currentTurnOnly: true });
      expect(calls.map(call => [call.toolUseId, call.lastUserMessage])).toEqual([['advice', privatePrompt]]);
    });
    it(`keeps confirmed file and work-state writes private with a meta message at position ${position}`, () => {
      const activity = extractTranscriptFileActivityFromJsonl(transcript(position));
      expect(activity).toMatchObject({ promptSeen: true, privateTurn: true });
      expect(activity.writes.map(write => write.path)).toEqual(['/work/report.md']);
      expect(activity.workStateWrites.map(write => write.list)).toEqual(['report']);
    });
  }

  for (const isMeta of [undefined, false]) {
    it(`still starts a new turn for an ordinary prompt (isMeta=${isMeta})`, () => {
      const content = [transcript(1), user('Start a separate task.', isMeta)].join('\n');
      expect(extractAdvisorCallsFromJsonl(content, { currentTurnOnly: true })).toEqual([]);
      expect(extractTranscriptFileActivityFromJsonl(content)).toEqual({ writes: [], workStateWrites: [], promptSeen: true, privateTurn: false });
    });
  }

  it('processes tool-result acknowledgements even when their user record is marked meta', () => {
    const content = [user(privatePrompt), invocation, user([
      { type: 'tool_result', tool_use_id: 'write', content: 'ok' },
      { type: 'text', text: 'An automatic notice accompanies the result.' },
    ], true)].join('\n');
    const activity = extractTranscriptFileActivityFromJsonl(content);
    expect(activity.privateTurn).toBe(true);
    expect(activity.writes.map(write => write.toolUseId)).toEqual(['write']);
  });

  it('continues the file-tail privacy scan past a meta message to the original prompt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cm-meta-turn-'));
    try {
      const path = join(directory, 'session.jsonl');
      writeFileSync(path, [user(privatePrompt), assistant([{ type: 'text', text: 'x'.repeat(4096) }]), notification, invocation, ...results].join('\n'));
      const activity = extractTranscriptFileActivity(path, { maxTailBytes: 1024 });
      expect(activity).toMatchObject({ promptSeen: true, privateTurn: true });
      expect(activity.writes.map(write => write.path)).toEqual(['/work/report.md']);
      expect(extractAdvisorCalls(path, { currentTurnOnly: true })[0].lastUserMessage).toBe(privatePrompt);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves the existing private-advice suppression through production SQLite ingest', () => {
    const store = new SessionStore(':memory:');
    try {
      const ingest = (prompt: string, sessionId: string) => ingestAdvisorCalls({
        contentSessionId: sessionId, platformSource: 'claude',
        calls: extractAdvisorCallsFromJsonl(transcript(1, prompt), { currentTurnOnly: true }),
      }, { getSessionStore: () => store } as any);
      expect(ingest(privatePrompt, 'private')).toMatchObject({ stored: 0, privateOnly: 1 });
      expect(store.getAdvisorCalls(0, 10).items).toHaveLength(0);
      expect(ingest('Write the public report.', 'public')).toMatchObject({ stored: 1, privateOnly: 0 });
      expect(store.getAdvisorCalls(0, 10).items[0].last_user_message).toBe('Write the public report.');
    } finally { store.close(); }
  });
});
