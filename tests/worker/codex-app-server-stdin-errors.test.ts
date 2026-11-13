import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeServer = String.raw`
import { appendFileSync, closeSync, existsSync, writeFileSync } from 'node:fs';
const root = FIXTURE_ROOT;
const failed = root + '/failed';
appendFileSync(root + '/launches', 'started\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let buffer = '';
const breakPipe = () => {
  process.stdin.pause();
  closeSync(0);
  setTimeout(() => process.exit(0), 10_000);
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === 'initialize') {
      send({ id: message.id, result: { userAgent: 'fixture' } });
    } else if (message.method === 'config/read') {
      send({ id: message.id, result: { config: {}, layers: [] } });
    } else if (message.method === 'thread/start') {
      send({ id: message.id, result: { thread: { id: 'thread-1' }, instructionSources: [] } });
    } else if (message.method === 'mcpServerStatus/list') {
      if (!existsSync(failed)) {
        writeFileSync(failed, 'closed');
        breakPipe();
      }
      send({ id: message.id, result: { data: [], nextCursor: null } });
    } else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-1', status: 'completed',
        items: [{ type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ content: 'new activity' }) }] } } });
    } else if (message.method === 'thread/unsubscribe') {
      send({ id: message.id, result: {} });
    }
  }
});
`;

const runner = String.raw`
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAppServerClient } from './src/services/worker/CodexAppServerClient.ts';
const [root, executable] = process.argv.slice(1);
const authHome = join(root, 'auth');
mkdirSync(authHome, { mode: 0o700 });
writeFileSync(join(authHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }), { mode: 0o600 });
// Contain the baseline's unhandled stream event inside this disposable host.
const uncaught = [];
process.on('uncaughtException', error => uncaught.push({ code: error.code, message: error.message }));
const client = new CodexAppServerClient({ nativeCodexHome: authHome });
let failure;
let recovered;
try {
  try {
    await client.runTurn({ codexPath: executable, model: '', reasoningEffort: null,
      prompt: 'x'.repeat(256 * 1024), timeoutMs: 5000 });
  } catch (error) {
    failure = { code: error.code, message: error.message };
  }
  // New caller activity may start a fresh child; the failed request is not replayed.
  recovered = await client.runTurn({ codexPath: executable, model: '', reasoningEffort: null,
    prompt: 'New explicit request', timeoutMs: 5000 });
} finally {
  await client.close();
}
console.log(JSON.stringify({ uncaught, failure, recovered, launches: readFileSync(join(root, 'launches'), 'utf8').trim().split('\n').length }));
`;

describe('Codex app-server stdin transport failure', () => {
  (process.platform === 'win32' ? it.skip : it)('contains a broken turn pipe and accepts a later explicit request', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-stdin-error-'));
    try {
      const executable = join(root, 'codex');
      writeFileSync(executable, `#!${process.execPath}\n${fakeServer.replace('FIXTURE_ROOT', JSON.stringify(root))}`, { mode: 0o700 });
      const result = Bun.spawnSync([process.execPath, '-e', runner, root, executable], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(root, 'data') },
        stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
      });
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
      const report = JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
      expect(report.uncaught).toEqual([]);
      expect(report.failure.code).toBe('EPIPE');
      expect(report.failure.message).not.toContain('timed out');
      expect(report.recovered.content).toBe('new activity');
      expect(report.launches).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
