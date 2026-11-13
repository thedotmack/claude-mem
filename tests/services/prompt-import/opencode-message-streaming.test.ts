import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createOpenCodeReader, type TypedPrompt } from '../../../src/services/prompt-import/readers.js';

const NOW = Date.parse('2026-11-13T12:00:00Z');

function fixture(role: 'user' | 'assistant') {
  const home = mkdtempSync(join(tmpdir(), 'cmem-opencode-message-stream-'));
  const path = join(home, '.local/share/opencode/opencode.db');
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, data TEXT);
    INSERT INTO session VALUES ('root', '/project', NULL);`);
  const messages = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
  const parts = database.prepare('INSERT INTO part VALUES (?, ?, ?)');
  // Many messages share timestamps; insertion order differs from native part order.
  for (let i = 39; i >= 0; i--) {
    const id = String(i).padStart(3, '0');
    messages.run(id, 'root', NOW + Math.floor(i / 3), JSON.stringify({ role }));
    parts.run(id + '-2', id, JSON.stringify({ type: 'text', text: 'second ' + id }));
    parts.run(id + '-1', id, JSON.stringify({ type: 'text', text: 'first ' + id }));
  }
  const reader = createOpenCodeReader();
  const source = reader.locate(home).sources[0];
  return { path, database, reader, source,
    close() { database.close(); rmSync(home, { recursive: true, force: true }); } };
}

it('retains ordered multipart owner prompts at message boundaries without modifying history', async () => {
  const f = fixture('user');
  try {
    const before = readFileSync(f.path);
    const prompts: TypedPrompt[] = [];
    const sessions = new Set<string>();
    await f.reader.readPrompts(f.source, {
      prompt: value => prompts.push(value), session: value => sessions.add(value),
    }, NOW);
    expect(prompts.map(prompt => [prompt.nativePromptId, prompt.text])).toEqual(
      Array.from({ length: 40 }, (_, i) => {
        const id = String(i).padStart(3, '0');
        return [id, 'first ' + id + '\nsecond ' + id];
      }),
    );
    expect([...sessions]).toEqual(['root']);
    expect(readFileSync(f.path)).toEqual(before);
  } finally { f.close(); }
});

it('retains complete multipart assistant evidence across equal timestamps', async () => {
  const f = fixture('assistant');
  try {
    const before = readFileSync(f.path);
    const evidence: Array<{ at: number; text: string }> = [];
    await f.reader.readAgentText(f.source, (at, text) => evidence.push({ at, text }));
    expect(evidence).toEqual(Array.from({ length: 40 }, (_, i) => {
      const id = String(i).padStart(3, '0');
      return { at: Math.floor((NOW + Math.floor(i / 3)) / 1000), text: 'first ' + id + '\nsecond ' + id };
    }));
    expect(readFileSync(f.path)).toEqual(before);
  } finally { f.close(); }
});

it('keeps tool-only messages and tool-input evidence when moving between messages', async () => {
  const f = fixture('assistant');
  try {
    f.database.run('INSERT INTO message VALUES (?, ?, ?, ?)', ['tool-only', 'root', NOW + 1000, '{"role":"assistant"}']);
    f.database.run('INSERT INTO part VALUES (?, ?, ?)', ['tool', 'tool-only', JSON.stringify({
      type: 'tool', state: { status: 'completed', input: { content: 'model-authored input' },
        output: 'untrusted tool output', time: { start: NOW + 1200 } },
    })]);
    const evidence: Array<{ at: number; text: string }> = [];
    await f.reader.readAgentText(f.source, (at, text) => evidence.push({ at, text }));
    expect(evidence).toContainEqual({ at: Math.floor((NOW + 1200) / 1000), text: 'model-authored input' });
    expect(evidence.some(item => item.text.includes('untrusted tool output'))).toBe(false);
    expect(evidence.filter(item => item.text.startsWith('first '))).toHaveLength(40);
  } finally { f.close(); }
});

for (const role of ['user', 'assistant'] as const) {
  it('releases the SQLite read cursor when the ' + role + ' consumer throws', async () => {
    const f = fixture(role);
    try {
      const stop = () => { throw new Error('consumer stopped'); };
      const scan = role === 'user'
        ? f.reader.readPrompts(f.source, { prompt: stop, session() {} }, NOW)
        : f.reader.readAgentText(f.source, stop);
      await expect(scan).rejects.toThrow('consumer stopped');
      // An unfinished read on the reader's separate connection would block this lock.
      expect(() => f.database.exec('BEGIN EXCLUSIVE; ROLLBACK;')).not.toThrow();
      const again: string[] = [];
      if (role === 'user') await f.reader.readPrompts(f.source, {
        prompt: prompt => again.push(prompt.text), session() {},
      }, NOW);
      else await f.reader.readAgentText(f.source, (_at, text) => again.push(text));
      expect(again).toHaveLength(40);
    } finally { f.close(); }
  });
}

it('closes the native history after a SQLite projection error so the source can be repaired', async () => {
  const f = fixture('assistant');
  try {
    f.database.run('UPDATE part SET data = ? WHERE id = ?', ['invalid JSON', '039-2']);
    await expect(f.reader.readAgentText(f.source, () => {})).rejects.toThrow();
    expect(() => f.database.exec('BEGIN EXCLUSIVE; ROLLBACK;')).not.toThrow();
    f.database.run('UPDATE part SET data = ? WHERE id = ?', [JSON.stringify({ type: 'text', text: 'second 039' }), '039-2']);
    let count = 0;
    await f.reader.readAgentText(f.source, () => { count++; });
    expect(count).toBe(40);
  } finally { f.close(); }
});

