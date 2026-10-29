import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FocusShareError, FocusShares } from '../../src/services/work-view/focus-share.js';

const ORIGIN = 'https://cmem.ai';
const TOKEN = 'a'.repeat(32);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown; redirect?: RequestRedirect }

/** A cmem.ai stand-in: answers each call with the next queued response and records what it was sent. */
function setup(responses: Array<{ status: number; body?: unknown }>, credentials = { token: 'setup-token', userId: 'user-1' }) {
  const dir = mkdtempSync(join(tmpdir(), 'focus-share-'));
  dirs.push(dir);
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined, redirect: init.redirect });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call ${init.method} ${url}`);
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  const registryPath = join(dir, 'focus-shares.json');
  const shares = new FocusShares({ origin: () => ORIGIN, credentials: () => credentials, registryPath, fetch: fetchImpl });
  return { shares, calls, registryPath };
}

const page = (percent = 40, generatedAt = '2026-10-29T20:00:00.000Z') => ({ version: 1, area: { id: 'area-1', name: 'Launch' }, requests: [{ id: 'r1', percent }], generatedAt });

describe('FocusShares', () => {
  it('shares an area once, then publishes to the same link, skipping a page that has not changed', async () => {
    const { shares, calls, registryPath } = setup([
      { status: 201, body: { token: TOKEN, url: `${ORIGIN}/focus/${TOKEN}`, created: true, publishedAt: '2026-10-29T20:00:01.000Z' } },
      { status: 200, body: { token: TOKEN, url: `${ORIGIN}/focus/${TOKEN}`, publishedAt: '2026-10-29T20:05:00.000Z' } },
    ]);
    const first = await shares.publish('area-1', page());
    expect(first.sent).toBe(true);
    expect(first.entry.url).toBe(`${ORIGIN}/focus/${TOKEN}`);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${ORIGIN}/api/focus-share`, body: { focusAreaId: 'area-1', snapshot: page() }, redirect: 'manual' });
    expect(calls[0].headers).toMatchObject({ Authorization: 'Bearer setup-token', 'X-User-Id': 'user-1' });

    // Rebuilt a minute later with nothing new: only generatedAt moved, so nothing is sent.
    const same = await shares.publish('area-1', page(40, '2026-10-29T20:01:00.000Z'));
    expect(same.sent).toBe(false);
    expect(calls).toHaveLength(1);

    const changed = await shares.publish('area-1', page(80));
    expect(changed.sent).toBe(true);
    expect(calls[1]).toMatchObject({ method: 'PUT', url: `${ORIGIN}/api/focus-share/${TOKEN}`, body: { snapshot: page(80) } });
    expect(changed.entry.publishedAt).toBe('2026-10-29T20:05:00.000Z');

    // The registry keeps links, never the credential, and only its owner reads it.
    const saved = readFileSync(registryPath, 'utf8');
    expect(saved).toContain(TOKEN);
    expect(saved).not.toContain('setup-token');
    if (process.platform !== 'win32') expect(statSync(registryPath).mode & 0o077).toBe(0);
    expect(Object.keys(shares.list())).toEqual(['area-1']);
  });

  it('forgets a link that was stopped elsewhere instead of reviving it', async () => {
    const { shares } = setup([
      { status: 201, body: { token: TOKEN, url: `${ORIGIN}/focus/${TOKEN}` } },
      { status: 404, body: { error: 'not_shared' } },
    ]);
    await shares.publish('area-1', page());
    const refused = await shares.publish('area-1', page(90)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FocusShareError);
    expect((refused as FocusShareError).status).toBe(410);
    expect(shares.list()).toEqual({});
  });

  it('refuses a link on another host', async () => {
    const { shares } = setup([{ status: 201, body: { token: TOKEN, url: `https://evil.example/focus/${TOKEN}` } }]);
    await expect(shares.publish('area-1', page())).rejects.toThrow('without a usable link');
    expect(shares.list()).toEqual({});
  });

  it('stops sharing, and treats a link already gone as stopped', async () => {
    const { shares, calls } = setup([
      { status: 201, body: { token: TOKEN, url: `${ORIGIN}/focus/${TOKEN}` } },
      { status: 404, body: { error: 'not_shared' } },
    ]);
    await shares.publish('area-1', page());
    await shares.stop('area-1');
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: `${ORIGIN}/api/focus-share/${TOKEN}` });
    expect(shares.list()).toEqual({});
    await shares.stop('area-1');
    expect(calls).toHaveLength(2);
  });

  it('reads comments and posts the owner\'s own', async () => {
    const comment = { id: 'c1', authorKind: 'agent', authorName: 'Miles', agentName: 'Codex', isOwner: false, body: 'Green.', createdAt: '2026-10-29T20:10:00.000Z' };
    const { shares, calls } = setup([
      { status: 201, body: { token: TOKEN, url: `${ORIGIN}/focus/${TOKEN}` } },
      { status: 200, body: { page: {}, publishedAt: '2026-10-29T20:00:01.000Z', comments: [comment] } },
      { status: 201, body: { comment: { ...comment, id: 'c2', authorKind: 'person', agentName: null, isOwner: true, body: 'Thanks' } } },
    ]);
    await shares.publish('area-1', page());
    expect(await shares.comments('area-1')).toEqual({ comments: [comment], publishedAt: '2026-10-29T20:00:01.000Z' });
    const posted = await shares.comment('area-1', 'Thanks');
    expect(posted.isOwner).toBe(true);
    expect(calls[2]).toMatchObject({ method: 'POST', url: `${ORIGIN}/api/focus-share/${TOKEN}/comments`, body: { body: 'Thanks' } });
    await expect(shares.comments('area-2')).rejects.toThrow('not shared');
  });

  it('says sharing needs cloud sync, and names a refused key', async () => {
    const offline = setup([], { token: '', userId: '' });
    expect(offline.shares.connected()).toBe(false);
    await expect(offline.shares.publish('area-1', page())).rejects.toThrow('Sharing needs cloud sync');
    expect(offline.calls).toHaveLength(0);
    expect(existsSync(offline.registryPath)).toBe(false);

    const refused = setup([{ status: 401, body: { error: 'Invalid token or user mismatch' } }]);
    await expect(refused.shares.publish('area-1', page())).rejects.toThrow('cloud sync key was refused');
  });
});

describe('FocusShares, one area at a time', () => {
  it('does not bring a stopped link back when an update answers after the stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'focus-share-'));
    dirs.push(dir);
    let releasePut!: () => void;
    const putHeld = new Promise<void>(resolve => { releasePut = resolve; });
    const methods: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      methods.push(init.method ?? 'GET');
      if (init.method === 'POST') return new Response(JSON.stringify({ token: TOKEN, url: `${ORIGIN}/focus/${TOKEN}` }), { status: 201 });
      if (init.method === 'PUT') { await putHeld; return new Response(JSON.stringify({ publishedAt: '2026-10-29T20:05:00.000Z' }), { status: 200 }); }
      return new Response(JSON.stringify({ stopped: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const shares = new FocusShares({ origin: () => ORIGIN, credentials: () => ({ token: 't', userId: 'u' }), registryPath: join(dir, 'focus-shares.json'), fetch: fetchImpl });
    await shares.publish('area-1', page());
    const update = shares.publish('area-1', page(70), { create: false });
    const stopped = shares.stop('area-1');
    releasePut();
    await update;
    await stopped;
    expect(methods).toEqual(['POST', 'PUT', 'DELETE']);
    expect(shares.list()).toEqual({});
    // A timed update after the stop is refused instead of making a new link.
    await expect(shares.publish('area-1', page(80), { create: false })).rejects.toThrow('no longer shared');
    expect(methods).toEqual(['POST', 'PUT', 'DELETE']);
  });
});

describe('FocusShares, late answers about an old link', () => {
  it('a comment read that finds the old link gone does not forget the new one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'focus-share-'));
    dirs.push(dir);
    const NEW = 'b'.repeat(32);
    let releaseRead!: () => void;
    const readHeld = new Promise<void>(resolve => { releaseRead = resolve; });
    let posts = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      if (method === 'POST') { const token = posts++ === 0 ? TOKEN : NEW; return new Response(JSON.stringify({ token, url: `${ORIGIN}/focus/${token}` }), { status: 201 }); }
      if (method === 'GET') { await readHeld; return new Response(JSON.stringify({ error: 'not_shared' }), { status: 404 }); }
      return new Response(JSON.stringify({ stopped: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const shares = new FocusShares({ origin: () => ORIGIN, credentials: () => ({ token: 't', userId: 'u' }), registryPath: join(dir, 'focus-shares.json'), fetch: fetchImpl });
    await shares.publish('area-1', page());
    const oldRead = shares.comments('area-1').catch((error: unknown) => error);
    await shares.stop('area-1');
    await shares.publish('area-1', page());
    releaseRead();
    expect(await oldRead).toBeInstanceOf(FocusShareError);
    expect(shares.list()['area-1']?.token).toBe(NEW);
  });
});
