import { describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DeepSearchClient } from '../../src/services/deep-search/DeepSearchClient.js';
import { DEEP_SEARCH_DEADLINE_MS, MAX_REPLY_BYTES } from '../../src/services/deep-search/protocol.js';
import { formatMcpPayload } from '../../src/servers/mcp-text-format.js';
import { deepSearchRuntimeSupported } from '../../src/services/deep-search/runtime-support.js';

const ok = { deep: { status: 'ok', complete: true, count: 0, hasMore: false }, toolUses: [] };
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: mock(() => true) });
  return child;
}
async function tick() { await new Promise<void>(resolve => setImmediate(resolve)); }

describe('deep search process lifecycle', () => {
  it('caches late preparation without spawning when no request remains', async () => {
    let ready!: (s: string) => void;
    const child = fakeChild(); const spawn = mock(() => child);
    const client = new DeepSearchClient('unused', { deadlineMs: 1000,
      program: () => new Promise(resolve => { ready = resolve; }), spawn: spawn as any });
    expect((await client.search('expired')).deep.status).toBe('timeout');
    ready('program'); await tick(); expect(spawn).not.toHaveBeenCalled();
    const next = client.search('new'); await tick();
    child.stdout.write(JSON.stringify({ version: 1, id: 2, result: ok })); child.emit('close', 0, null);
    expect(await next).toEqual(ok); await client.close();
  });

  it('fails the live request on late preparation rejection and permits a fresh build', async () => {
    let reject!: (reason: Error) => void;
    const child = fakeChild(); const spawn = mock(() => child);
    let builds = 0;
    const client = new DeepSearchClient('unused', { deadlineMs: 1000, spawn: spawn as any,
      program: () => ++builds === 1 ? new Promise((_resolve, fail) => { reject = fail; }) : Promise.resolve('program') });
    expect((await client.search('expired')).deep.status).toBe('timeout');
    const live = client.search('live'); reject(new Error('late failure'));
    expect((await live).deep.status).toBe('error'); expect(spawn).not.toHaveBeenCalled();
    const retry = client.search('retry'); await tick();
    child.stdout.write(JSON.stringify({ version: 1, id: 3, result: ok })); child.emit('close', 0, null);
    expect(await retry).toEqual(ok); expect(builds).toBe(2); await client.close();
  });

  it('closes admission before a replacement request can start during preparation', async () => {
    const spawn = mock(() => fakeChild());
    const client = new DeepSearchClient('unused', { program: () => new Promise(() => {}), spawn: spawn as any });
    const first = client.search('first'); const closed = client.close();
    expect((await client.search('replacement')).deep.status).toBe('cancelled');
    await closed; expect((await first).deep.status).toBe('cancelled'); expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed if neither parent kill nor the child guard produces an exit', async () => {
    const child = fakeChild(); child.kill = mock(() => false);
    const client = new DeepSearchClient('unused', { deadlineMs: 5, program: async () => '', spawn: (() => child) as any });
    expect((await client.search('one')).deep.status).toBe('timeout');
    expect((await client.search('two')).deep.status).toBe('busy');
    let closed = false; const closing = client.close().then(() => { closed = true; });
    await tick(); expect(closed).toBe(false);
    expect((await client.search('three')).deep.status).toBe('cancelled');
    // No wall-clock timer may invent an exit. Simulate eventual OS confirmation
    // only to tear down the fake; the failure policy is to reject new work.
    child.emit('close', null, 'SIGKILL'); await closing; expect(closed).toBe(true);
  });
  it('detaches timed-out requests from a hung preparation without stacking builds or hanging close', async () => {
    const program = mock(() => new Promise<string>(() => {}));
    const spawn = mock(() => fakeChild());
    const client = new DeepSearchClient('unused', { deadlineMs: 5, program, spawn: spawn as any });
    for (let i = 0; i < 5; i++) expect((await client.search('x')).deep.status).toBe('timeout');
    expect(program).toHaveBeenCalledTimes(1);
    await client.close();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cancels close during preparation immediately and never spawns its late result', async () => {
    let ready!: (s: string) => void;
    const spawn = mock(() => fakeChild());
    const client = new DeepSearchClient('unused', { program: () => new Promise(resolve => { ready = resolve; }), spawn: spawn as any });
    const pending = client.search('x'); await tick();
    await client.close();
    expect((await pending).deep.status).toBe('cancelled');
    ready('program'); await tick();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a late preparation serves only the new live request', async () => {
    let ready!: (s: string) => void;
    const child = fakeChild();
    const spawn = mock(() => child);
    const client = new DeepSearchClient('unused', { deadlineMs: 1000, program: () => new Promise(resolve => { ready = resolve; }), spawn: spawn as any });
    expect((await client.search('expired')).deep.status).toBe('timeout');
    const live = client.search('live'); ready('program'); await tick();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(child.stdin.read().toString()).query).toBe('live');
    child.stdout.write(JSON.stringify({ version: 1, id: 2, result: ok })); child.emit('close', 0, null);
    expect(await live).toEqual(ok); await client.close();
  });

  it('does not let an old spawn error/close clear a newer job', async () => {
    const old = fakeChild(); (old as any).pid = undefined;
    let child = old;
    const client = new DeepSearchClient('unused', { program: async () => '', spawn: (() => child) as any });
    const first = client.search('first'); await tick(); old.emit('error', new Error('spawn failed'));
    expect((await first).deep.status).toBe('error');
    child = fakeChild(); const next = client.search('next'); await tick();
    old.emit('close', 1, null); old.emit('close', 1, null);
    expect((await client.search('third')).deep.status).toBe('busy');
    child.stdout.write(JSON.stringify({ version: 1, id: 2, result: ok })); child.emit('close', 0, null);
    expect(await next).toEqual(ok); await client.close();
  });

  it('treats a reply at the exact deadline as timeout even before the timer callback runs', async () => {
    let now = 0;
    const child = fakeChild();
    const client = new DeepSearchClient('unused', { now: () => now, program: async () => '', spawn: (() => child) as any });
    const pending = client.search('x'); await tick(); now = DEEP_SEARCH_DEADLINE_MS;
    child.stdout.write(JSON.stringify({ version: 1, id: 1, result: ok })); child.emit('close', 0, null);
    expect((await pending).deep.status).toBe('timeout'); await client.close();
  });

  it('rejects unsupported embedded runtimes before preparation/spawn and keeps old source runtimes distinct', async () => {
    for (const main of ['/$bunfs/root/worker.js', 'B:/~BUN/root/worker.js', 'B:\\~BUN\\root\\worker.js']) {
      expect(deepSearchRuntimeSupported('1.2.15', main)).toBe(false);
      expect(deepSearchRuntimeSupported('1.2.16', main)).toBe(true);
      expect(deepSearchRuntimeSupported('unknown', main)).toBe(false);
    }
    expect(deepSearchRuntimeSupported('1.1.31', '/source/worker.ts')).toBe(true);
    const program = mock(async () => ''); const spawn = mock(() => fakeChild());
    const client = new DeepSearchClient('unused', { runtimeSupported: () => false, program, spawn: spawn as any });
    expect((await client.search('x')).deep.status).toBe('unsupported');
    expect(program).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled(); await client.close();
  });
  it('counts preparation in the deadline and never spawns after it expires', async () => {
    let ready!: (s: string) => void;
    const spawn = mock(() => fakeChild());
    const client = new DeepSearchClient('unused', { deadlineMs: 10, spawn: spawn as any,
      program: () => new Promise(resolve => { ready = resolve; }) });
    const pending = client.search('one');
    expect((await client.search('two')).deep.status).toBe('busy');
    const result = await pending;
    expect(result.deep).toEqual({ status: 'timeout', complete: false, count: null, hasMore: null });
    expect((await client.search('three')).deep.status).toBe('timeout');
    ready('code');
    await client.close();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('retains the slot after timeout until exit, ignoring a late successful reply', async () => {
    const child = fakeChild();
    const client = new DeepSearchClient('unused', { deadlineMs: 10, program: async () => '', spawn: (() => child) as any });
    const result = await client.search('one');
    expect(result.deep.status).toBe('timeout');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect((await client.search('two')).deep.status).toBe('busy');
    child.stdout.write(JSON.stringify({ version: 1, id: 1, result: ok }));
    child.emit('close', 0, null);
    expect(result.deep.status).toBe('timeout');
    await client.close();
  });

  it('reassembles split UTF-8, waits for exit, then allows the next generation', async () => {
    let child = fakeChild();
    const client = new DeepSearchClient('unused', { program: async () => '', spawn: (() => child) as any });
    const pending = client.search('one'); await tick();
    const result = { deep: { ...ok.deep, count: 1 }, toolUses: [{ id: 1, tool_use_id: 'id', tool_name: 'Read',
      project: '项目', content_session_id: 'session', platform_source: 'claude-code', created_at_epoch: 1, snippet: '中文🧪' }] };
    const bytes = Buffer.from(JSON.stringify({ version: 1, id: 1, result }));
    for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
    expect((await client.search('busy')).deep.status).toBe('busy');
    child.emit('close', 0, null);
    expect(await pending).toEqual(result);
    child = fakeChild();
    const second = client.search('two'); await tick();
    child.stdout.write(JSON.stringify({ version: 1, id: 2, result: ok })); child.emit('close', 0, null);
    expect(await second).toEqual(ok); await client.close();
  });

  for (const mode of ['malformed', 'oversize', 'wrong-id', 'abnormal-exit']) {
    it(`reports ${mode} as incomplete and reaps the child`, async () => {
      const child = fakeChild();
      const client = new DeepSearchClient('unused', { program: async () => '', spawn: (() => child) as any });
      const pending = client.search('one'); await tick();
      child.stdout.write(mode === 'oversize' ? Buffer.alloc(MAX_REPLY_BYTES + 1) : mode === 'malformed' ? 'bad'
        : JSON.stringify({ version: 1, id: mode === 'wrong-id' ? 99 : 1, result: ok }));
      child.emit('close', mode === 'abnormal-exit' ? 1 : 0, null);
      expect((await pending).deep).toEqual({ status: 'error', complete: false, count: null, hasMore: null });
      await client.close();
    });
  }

  it('fails closed on preparation/spawn errors and can recover', async () => {
    const client = new DeepSearchClient('unused', { program: async () => { throw new Error('build failed'); } });
    expect((await client.search('one')).deep.status).toBe('error');
    expect((await client.search('two')).deep.status).toBe('error');
    await client.close();
    const spawnFailure = new DeepSearchClient('unused', { program: async () => '', spawn: (() => { throw new Error('spawn failed'); }) as any });
    expect((await spawnFailure.search('one')).deep.status).toBe('error');
    await spawnFailure.close();
  });

  it('makes close idempotent, cancels the response, and waits for confirmed exit', async () => {
    const child = fakeChild();
    const client = new DeepSearchClient('unused', { program: async () => '', spawn: (() => child) as any });
    const pending = client.search('one'); await tick();
    let closed = false;
    const close = client.close().then(() => { closed = true; });
    const again = client.close();
    expect((await pending).deep.status).toBe('cancelled');
    expect(closed).toBe(false);
    expect((await client.search('new')).deep.status).toBe('cancelled');
    child.emit('close', null, 'SIGKILL');
    await Promise.all([close, again]); expect(closed).toBe(true);
  });

  it('preserves incomplete status in MCP after large ordinary results', () => {
    for (const status of ['busy', 'timeout', 'cancelled', 'unsupported', 'error']) {
      const result = { deep: { status, complete: false, count: null, hasMore: null }, toolUses: [],
        sessions: Array.from({ length: 500 }, () => ({ request: 'summary'.repeat(200) })) };
      const text = formatMcpPayload('search', result).content[0].text;
      expect(text).toContain(`Raw tool search: ${status}.`);
      expect(text).toContain('does not mean no raw evidence');
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32 * 1024);
    }
  });
});
