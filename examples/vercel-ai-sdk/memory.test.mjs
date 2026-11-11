import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

if (!process.env.CLAUDE_MEM_MCP_SERVER || !process.env.CLAUDE_MEM_WORKER_PORT) {
  throw new Error('Start an isolated worker and set CLAUDE_MEM_MCP_SERVER and CLAUDE_MEM_WORKER_PORT before this live integration test.');
}
const script = fileURLToPath(new URL('./memory.mjs', import.meta.url));
const project = `vercel-sdk-test-${randomUUID()}`;
const otherProject = `${project}-other`;
function run(args, overrides = {}, cwd) {
  return spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, ...overrides }, cwd, encoding: 'utf8', timeout: 25_000,
  });
}
function ok(args) {
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('real AI SDK tool conversion saves, deduplicates, searches, and retrieves across clients', () => {
  const note = 'Vercel workflow decision: use the sapphire deployment region.';
  const saved = ok(['save', project, 'Vercel workflow decision', note]);
  const id = /Saved memory #(\d+)/.exec(saved)?.[1];
  assert.ok(id, saved);
  assert.match(ok(['save', project, 'Vercel workflow decision', note]), new RegExp(`already saved as #${id}\\b`));
  const index = ok(['search', project, 'Vercel workflow decision']);
  assert.match(index, new RegExp(`#${id}\\b`));
  assert.ok(!index.includes('sapphire deployment region'), 'search remains an index');
  assert.match(ok(['timeline', project, id]), /Vercel workflow decision/);
  assert.match(ok(['show', project, id]), /sapphire deployment region/);

  const other = ok(['save', otherProject, 'Vercel workflow decision elsewhere', 'The other project uses the coral deployment region.']);
  const otherId = /Saved memory #(\d+)/.exec(other)?.[1];
  assert.ok(otherId);
  assert.doesNotMatch(ok(['search', project, 'Vercel workflow decision']), new RegExp(`#${otherId}\\b`));
  assert.ok(!ok(['show', project, otherId]).includes('coral deployment region'));
});

test('invalid input fails before connecting or claiming a save', () => {
  for (const args of [['save', project, 'Empty note', ''], ['show', project, '-1'], ['search', '', 'decision']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage:/);
  }
});

test('the selected project stays exact when the client starts in a Git worktree', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'AI SDK worktree '));
  const parentName = `vercel-parent-${randomUUID()}`;
  const parent = join(directory, parentName);
  const checkout = join(directory, 'checkout');
  const selected = `${parentName}/checkout`;
  const git = (...args) => {
    const result = spawnSync('git', args, { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  };
  const fromCheckout = args => run(args, {}, checkout);
  try {
    git('init', parent);
    git('-C', parent, '-c', 'user.name=Memory Test', '-c', 'user.email=memory@example.invalid', 'commit', '--allow-empty', '-m', 'Fixture');
    git('-C', parent, 'worktree', 'add', '--detach', checkout, 'HEAD');
    const parentNote = fromCheckout(['save', parentName, 'Worktree scope decision parent', 'Parent-only amber decision.']);
    const childNote = fromCheckout(['save', selected, 'Worktree scope decision selected', 'Selected-only teal decision.']);
    assert.equal(parentNote.status, 0, parentNote.stderr);
    assert.equal(childNote.status, 0, childNote.stderr);
    const parentId = /Saved memory #(\d+)/.exec(parentNote.stdout)?.[1];
    const selectedId = /Saved memory #(\d+)/.exec(childNote.stdout)?.[1];
    assert.ok(parentId && selectedId);

    await t.test('search does not inherit the parent project', () => {
      const result = fromCheckout(['search', selected, 'Worktree scope decision']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`#${selectedId}\\b`));
      assert.doesNotMatch(result.stdout, new RegExp(`#${parentId}\\b`));
    });
    await t.test('timeline does not include the parent note', () => {
      const result = fromCheckout(['timeline', selected, selectedId]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Worktree scope decision selected/);
      assert.doesNotMatch(result.stdout, /Worktree scope decision parent/);
    });
    await t.test('selected IDs cannot retrieve a parent note', () => {
      const own = fromCheckout(['show', selected, selectedId]);
      assert.equal(own.status, 0, own.stderr);
      assert.match(own.stdout, /Selected-only teal decision/);
      const result = fromCheckout(['show', selected, parentId]);
      assert.doesNotMatch(result.stdout, /Parent-only amber decision/);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the MCP script can live at an absolute path containing spaces', () => {
  const directory = mkdtempSync(join(tmpdir(), 'AI SDK MCP path '));
  const target = join(directory, 'memory server.cjs');
  try {
    copyFileSync(process.env.CLAUDE_MEM_MCP_SERVER, target);
    const result = run(['search', project, 'Vercel workflow decision'], { CLAUDE_MEM_MCP_SERVER: target });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Vercel workflow decision/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a refused worker connection fails honestly without auto-start', async () => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const result = run(['save', project, 'Unavailable worker', 'Do not report this as saved.'], { CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(port) });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Memory request failed/);
});

test('an unresponsive worker is bounded by the AI SDK execution signal', async () => {
  // A listening socket without an HTTP response exercises the real MCP
  // transport and SDK deadline; no memory request is reported successful.
  const sockets = new Set();
  const stalled = createServer(socket => sockets.add(socket));
  await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
  const started = Date.now();
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, 'search', project, 'decision'], {
        env: { ...process.env, CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(stalled.address().port) },
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 25_000,
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', status => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Memory request failed/);
    assert.ok(sockets.size > 0, 'the request reached the deliberately stalled worker');
    assert.ok(Date.now() - started < 22_000, 'the SDK abort bounds the request');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => stalled.close(resolve));
  }
});
