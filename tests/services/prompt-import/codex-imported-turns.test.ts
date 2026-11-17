import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCodexReader, type TypedPrompt } from '../../../src/services/prompt-import/readers.js';

const IMPORTED_AT = '2026-10-01T00:00:00.000Z';

function event(type: string, turnId: string, timestamp: string) {
  return { type: 'event_msg', timestamp, payload: { type, turn_id: turnId } };
}

function message(role: 'user' | 'assistant', text: string, timestamp: string) {
  return { type: 'response_item', timestamp,
    payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } };
}

/** A turn as Codex records it: the start event, the owner's message, the agent's reply, the completion event. */
function turn(turnId: string, text: string, timestamp: string, complete = true) {
  return [event('task_started', turnId, timestamp), message('user', text, timestamp),
    message('assistant', `reply to ${text}`, timestamp), ...(complete ? [event('task_complete', turnId, timestamp)] : [])];
}

/** The turns Codex Desktop writes when it copies another agent's conversation in: every record carries the import time. */
function importedTurns(...texts: string[]) {
  return texts.flatMap((text, index) => turn(`external-import-turn-${index + 1}`, text, IMPORTED_AT));
}

async function read(records: object[]): Promise<string[]> {
  const folder = mkdtempSync(join(tmpdir(), 'codex-imported-turns-'));
  try {
    const file = join(folder, 'rollout.jsonl');
    const meta = { type: 'session_meta', timestamp: IMPORTED_AT,
      payload: { id: 'imported-thread', source: 'vscode', originator: 'Codex Desktop', cwd: '/example' } };
    writeFileSync(file, [meta, ...records].map(record => JSON.stringify(record)).join('\n'));
    const info = statSync(file);
    const result: TypedPrompt[] = [];
    await createCodexReader().readPrompts({ path: file, bytes: info.size, mtimeMs: info.mtimeMs, holdsPrompts: true },
      { prompt: prompt => result.push(prompt), session() {} }, 0);
    return result.map(prompt => prompt.text);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

describe('Codex conversations imported from another agent', () => {
  it('reads no owner prompt from a conversation that was only imported', async () => {
    expect(await read(importedTurns('typed in the other agent', 'also typed in the other agent'))).toEqual([]);
  });

  it('reads only the prompts typed in Codex after the import', async () => {
    const records = [...importedTurns('typed in the other agent', 'also typed in the other agent'),
      ...turn('01a11a23-d9db-7403-bac1-e4dbf8d026f5', 'continue in Codex', '2026-10-01T00:05:00.000Z'),
      ...turn('01a11a23-e0aa-7c11-9f3e-5d0c1f2a9b77', 'and once more', '2026-10-01T00:09:00.000Z')];
    expect(await read(records)).toEqual(['continue in Codex', 'and once more']);
  });

  it('reads the first Codex prompt when the imported turn never recorded its completion', async () => {
    const records = [...turn('external-import-turn-1', 'typed in the other agent', IMPORTED_AT, false),
      ...turn('01a11a23-d9db-7403-bac1-e4dbf8d026f5', 'continue in Codex', '2026-10-01T00:05:00.000Z')];
    expect(await read(records)).toEqual(['continue in Codex']);
  });

  it('reads every prompt of a conversation that was never imported', async () => {
    const records = [...turn('01a11a23-d9db-7403-bac1-e4dbf8d026f5', 'first native prompt', '2026-10-01T00:05:00.000Z'),
      ...turn('01a11a23-e0aa-7c11-9f3e-5d0c1f2a9b77', 'second native prompt', '2026-10-01T00:09:00.000Z')];
    expect(await read(records)).toEqual(['first native prompt', 'second native prompt']);
  });
});
