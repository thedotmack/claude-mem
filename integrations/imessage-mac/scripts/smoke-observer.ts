/** Test the compiled executable in an empty home using synthetic groups and a local Photon stub. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { FakeChatDb } from '../../../tests/fixtures/imessage/fake-chat-db';

const binary = resolve(process.argv[2]);
const home = mkdtempSync(join(tmpdir(), 'claude-mem-observer-'));
const data = join(home, '.claude-mem');
mkdirSync(data);
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === '/api/health') return Response.json({ status: 'ok' });
    if (request.headers.get('authorization') !== 'Basic ' + Buffer.from('fixture:fixtureSecret').toString('base64')) {
      return new Response(null, { status: 401 });
    }
    return Response.json({ succeed: true, data: {
      type: 'dedicated', auth: { test: 'fixtureToken' }, numbers: { test: 'Test line' }, expiresIn: 60,
    } });
  },
});
const env = {
  HOME: home, PATH: '/usr/bin:/bin', CLAUDE_MEM_DATA_DIR: data,
  CLAUDE_MEM_WORKER_URL: server.url.origin, SPECTRUM_CLOUD_URL: server.url.origin,
};

async function run(args: string[], input = '', status = 0) {
  const child = Bun.spawn([binary, 'imessage', ...args], { cwd: home, env, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, status, err + out);
    assert.doesNotMatch(out + err, /fixtureSecret|fixtureToken/);
    return out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } finally { clearTimeout(timeout); }
}

try {
  const before = await run(['photon', 'check', '--json']);
  assert.equal(before[0].configured, false);
  const connected = await run(['photon', 'connect', '--json'], JSON.stringify({ projectId: 'fixture', projectSecret: 'fixtureSecret' }));
  assert.deepEqual(connected[0].lineNumbers, ['Test line']);
  assert.equal(connected[0].worker.reachable, true);
  const confPath = join(data, 'imessage-observer', 'config.json');
  const saved = readFileSync(confPath, 'utf8');
  const invalid = await run(['photon', 'connect', '--json'], JSON.stringify({ projectId: 'fixture', projectSecret: 'wrong' }), 1);
  assert.equal(invalid[0].type, 'error');
  assert.equal(readFileSync(confPath, 'utf8'), saved);
  assert.equal(statSync(confPath).mode & 0o777, 0o600);

  // Legacy CLI opt-in for direct messages never widens the app's group subscription.
  writeFileSync(confPath, JSON.stringify({ ...JSON.parse(saved), includeDirect: true }));
  const feed = resolve(import.meta.dir, '../../../tests/fixtures/imessage/group-chats.jsonl');
  const replay = await run(['photon', 'observe', '--replay', feed, '--dry-run', '--json']);
  const windows = JSON.stringify(replay.filter(event => event.type === 'dry-run'));
  assert.match(windows, /Booked 7:30/);
  assert.doesNotMatch(windows, /This direct message must not be observed/);
  assert.equal(replay.at(-1)?.type, 'stopped');

  const dbPath = join(home, 'chat.db');
  const fixture = new FakeChatDb(dbPath);
  const guid = 'any;+;fixture';
  fixture.chat(guid, { name: 'Test group', group: true, members: ['fixture@example.invalid'] });
  fixture.close();
  assert.equal((await run(['mac', 'check', '--db', dbPath, '--json']))[0].messages.ok, true);
  await run(['mac', 'pick', guid, '--on', '--json']);
  assert.equal((await run(['mac', 'chats', '--db', dbPath, '--json']))[0].chats[0].observed, true);
  const child = spawn(binary, ['imessage', 'mac', 'observe', '--db', dbPath, '--json', '--dry-run'], { env, cwd: home });
  const closed = once(child, 'close');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const seen: string[] = [];
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const event = JSON.parse(line);
      seen.push(event.type);
      if (event.type === 'started') child.stdin.end();
    }
    assert.equal((await closed)[0], 0);
    assert.ok(seen.includes('started'));
    assert.ok(seen.includes('stopped'));
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  console.log('Compiled observer passed Photon connection, group-only handoff, selected Mac chats, start and stop.');
} finally {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
}
