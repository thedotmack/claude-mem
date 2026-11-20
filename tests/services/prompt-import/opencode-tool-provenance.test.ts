import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { scanOwnerPrompts } from '../../../src/services/prompt-import/index.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const TEXT = 'Please implement the plan with a focused regression test.\nQuote "verified" only after checking the result and remaining limitations. '.repeat(3).trim();
const cases = [
  { name: 'completed tool input', status: 'completed', authored: true },
  { name: 'running tool input', status: 'running', authored: true },
  { name: 'failed subagent tool input', status: 'error', authored: true, subagent: true },
  { name: 'tool output is not agent-authored input', status: 'completed', authored: false, outputOnly: true },
  { name: 'tool input emitted after the prompt is not earlier evidence', status: 'completed', authored: false, future: true },
  { name: 'missing tool start is not evidence', status: 'completed', authored: false, missingStart: true },
  { name: 'invalid tool start is not evidence', status: 'completed', authored: false, invalidStart: true },
  { name: 'nonfinite tool start is not evidence', status: 'completed', authored: false, nonfiniteStart: true },
  { name: 'negative tool start is not evidence', status: 'completed', authored: false, negativeStart: true },
  { name: 'pending input is not completed model input', status: 'pending', authored: false },
  { name: 'a user-role tool part is not assistant evidence', status: 'completed', authored: false, userRole: true },
  { name: 'ordinary assistant text keeps its existing evidence', status: 'completed', authored: true, textOnly: true },
];

for (const testCase of cases) {
  it(`OpenCode provenance: ${testCase.name}`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'cmem-opencode-tool-provenance-'));
    const folder = join(home, '.local', 'share', 'opencode');
    mkdirSync(folder, { recursive: true });
    const database = new Database(join(folder, 'opencode.db'));
    const store = new SessionStore(':memory:', { syncOpsEnabled: false });
    try {
      database.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, data TEXT);`);
      database.query('INSERT INTO session VALUES(?, ?, ?)').run('root', '/projects/example', null);
      if (testCase.subagent) database.query('INSERT INTO session VALUES(?, ?, ?)').run('subagent', '/projects/example', 'root');
      database.query('INSERT INTO message VALUES(?, ?, ?, ?)').run('assistant', testCase.subagent ? 'subagent' : 'root',
        NOW - 20_000, JSON.stringify({ role: testCase.userRole ? 'user' : 'assistant' }));
      const start = testCase.future ? NOW + 10_000 : NOW - 10_000;
      const state = { status: testCase.status, input: { filePath: '/projects/plan.md', ...(testCase.outputOnly ? {} : { content: TEXT }) },
        time: { ...(testCase.missingStart ? {} : { start: testCase.invalidStart ? 'invalid' : testCase.nonfiniteStart ? Infinity : testCase.negativeStart ? -1 : start }), ...(testCase.status === 'running' ? {} : { end: start + 1000 }) },
        ...(testCase.status === 'completed' ? { title: 'plan', metadata: {}, output: testCase.outputOnly ? TEXT : 'file written' } : {}),
        ...(testCase.status === 'error' ? { error: 'write failed' } : {}) };
      const part = testCase.textOnly ? { type: 'text', text: TEXT } : { type: 'tool',
        callID: 'call-native', tool: testCase.outputOnly ? 'read' : 'write', state };
      const encoded = JSON.stringify(part);
      // Exercise SQLite JSON's numeric overflow rather than JSON.stringify's conversion to null.
      const data = testCase.nonfiniteStart ? encoded.replace('\"start\":null', '\"start\":1e999') : encoded;
      database.query('INSERT INTO part VALUES(?, ?, ?)').run('agent-part', 'assistant', data);
      database.query('INSERT INTO message VALUES(?, ?, ?, ?)').run('user', 'root', NOW, JSON.stringify({ role: 'user' }));
      database.query('INSERT INTO part VALUES(?, ?, ?)').run('user-part', 'user', JSON.stringify({ type: 'text', text: TEXT }));
      const options = { homeDirectory: home, agents: ['opencode'] as const, sinceEpochMs: NOW - 30 * 86400000,
        excludedProjects: '', resolveProject: () => 'example' };
      const result = await scanOwnerPrompts({ ...options, agents: [...options.agents] });
      const scanner = new SetupScan({ getStore: () => store, now: () => NOW,
        scanOptions: { ...options, agents: [...options.agents] } });
      scanner.start();
      const imported = await scanner.finished();
      const rows = store.db.query('SELECT prompt_text FROM user_prompts').all();
      expect({ owner: result.ownerPrompts.map(prompt => prompt.text), written: result.agentWritten.map(prompt => prompt.text),
        added: imported.added, rows }).toEqual(testCase.authored
          ? { owner: [], written: [TEXT], added: 0, rows: [] }
          : { owner: [TEXT], written: [], added: 1, rows: [{ prompt_text: TEXT }] });
    } finally {
      store.close(); database.close(); rmSync(home, { recursive: true, force: true });
    }
  });
}
