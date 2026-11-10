import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FocusShares } from '../../src/services/work-view/focus-share.js';
import { FocusSharePublisher } from '../../src/services/work-view/focus-share-publisher.js';
import type { WorkViewSnapshot } from '../../src/services/work-view/data-source.mjs';
import type { SharedFocusPage } from '../../src/ui/my-work/src/live/to-shared-focus.js';

const fixture = JSON.parse(readFileSync(join(import.meta.dir, '../../src/ui/my-work/test-fixtures/work-view-snapshot.trimmed.json'), 'utf8'));
const [first, second, third] = fixture.humanRequests.map((request: { id: string }) => request.id);
const now = Date.parse(fixture.generatedAt);
function snapshot(placements: Record<string, string>): WorkViewSnapshot {
  return {
    ...fixture,
    focusAreas: ['launch', 'docs'].map(focusAreaId => ({
      focusAreaId, name: focusAreaId, status: 'kept', goal: null, priorityRank: null, ownerRank: null,
      source: 'owner-goals', mergedInto: null, evidence: null, decidedBy: 'owner', savedAt: null,
    })),
    humanRequests: fixture.humanRequests.map((request: { id: string }) => ({ ...request, focusAreaId: placements[request.id] ?? null })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let directory: string;
let server: ReturnType<typeof Bun.serve>;
let shares: FocusShares;
let publisher: FocusSharePublisher;
let view: WorkViewSnapshot;
let readSnapshot: () => WorkViewSnapshot | Promise<WorkViewSnapshot>;
let beforePutReply: ((id: string) => Promise<void>) | undefined;
const pages = new Map<string, SharedFocusPage>();
const tokens = new Map<string, string>();
const releases: Array<() => void> = [];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'focus-share-round-order-'));
  pages.clear();
  tokens.clear();
  beforePutReply = undefined;
  let nextToken = 0;
  let origin: string;
  // A local sharing-service stand-in retains the actual pages sent over HTTP by
  // FocusShares. No public page or real credential is used by the regression.
  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (request.method === 'POST' && pathname === '/api/focus-share') {
        const body = await request.json() as { focusAreaId: string; snapshot: SharedFocusPage };
        const token = (++nextToken).toString(36).padStart(32, 'a');
        tokens.set(body.focusAreaId, token);
        pages.set(body.focusAreaId, body.snapshot);
        return Response.json({ token, url: `${origin}/focus/${token}`, publishedAt: fixture.generatedAt }, { status: 201 });
      }
      const token = pathname.split('/').at(-1);
      const id = [...tokens].find(([, value]) => value === token)?.[0];
      if (!id) return Response.json({ error: 'not_shared' }, { status: 404 });
      if (request.method === 'PUT') {
        const body = await request.json() as { snapshot: SharedFocusPage };
        pages.set(id, body.snapshot);
        await beforePutReply?.(id);
        return Response.json({ publishedAt: fixture.generatedAt });
      }
      if (request.method === 'DELETE') {
        tokens.delete(id);
        pages.delete(id);
        return Response.json({ stopped: true });
      }
      return new Response('Unexpected method', { status: 405 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  shares = new FocusShares({ origin: () => origin, credentials: () => ({ token: 'fixture-key', userId: 'fixture-owner' }), registryPath: join(directory, 'focus-shares.json') });
  view = snapshot({});
  readSnapshot = () => view;
  publisher = new FocusSharePublisher({ shares, snapshot: () => readSnapshot(), now: () => now, everyMs: 0 });
  await publisher.publishArea('launch');
  await publisher.publishArea('docs');
});

afterEach(() => {
  for (const release of releases.splice(0)) release();
  publisher.close();
  server.stop(true);
  rmSync(directory, { recursive: true, force: true });
});

const requestIds = () => pages.get('docs')!.requests.map(request => request.id).sort();

for (const action of ['publish', 'stop and share again'] as const) {
  it(`keeps the owner's ${action} when an earlier area's timed update finishes later`, async () => {
    const entered = deferred<void>();
    const held = deferred<void>();
    releases.push(() => held.resolve());
    beforePutReply = async id => {
      if (id === 'launch') { entered.resolve(); await held.promise; }
    };
    view = snapshot({ [first]: 'launch', [second]: 'docs' });
    const round = publisher.publishAll();
    await entered.promise;
    const previousToken = tokens.get('docs');
    view = snapshot({ [first]: 'launch', [third]: 'docs' });
    if (action === 'stop and share again') await publisher.stopArea('docs');
    await publisher.publishArea('docs');
    expect(requestIds()).toEqual([third]);
    if (action === 'stop and share again') expect(tokens.get('docs')).not.toBe(previousToken);

    held.resolve();
    await round;

    expect(requestIds()).toEqual([third]);
    expect((await shares.publish('docs', pages.get('docs')!)).sent).toBe(false);
    // The ownership fence belongs to one round. Later automatic updates still
    // publish the area's current content without another owner request.
    beforePutReply = undefined;
    view = snapshot({ [first]: 'launch', [second]: 'docs', [third]: 'docs' });
    await publisher.publishAll();
    expect(requestIds()).toEqual([second, third].sort());
  });
}

it('does not publish a late snapshot over a page the owner already refreshed', async () => {
  const entered = deferred<void>();
  const held = deferred<WorkViewSnapshot>();
  const earlier = snapshot({ [first]: 'launch', [second]: 'docs' });
  releases.push(() => held.resolve(earlier));
  readSnapshot = () => { entered.resolve(); return held.promise; };
  const round = publisher.publishAll();
  await entered.promise;
  view = snapshot({ [first]: 'launch', [third]: 'docs' });
  readSnapshot = () => view;
  await publisher.publishArea('docs');
  held.resolve(earlier);
  await round;

  expect(requestIds()).toEqual([third]);
  expect(pages.get('launch')!.requests.map(request => request.id)).toEqual([first]);
});

it('respects an owner publication that was already reading when the timed round began', async () => {
  const ownerEntered = deferred<void>();
  const ownerHeld = deferred<WorkViewSnapshot>();
  const launchEntered = deferred<void>();
  const launchHeld = deferred<void>();
  releases.push(() => ownerHeld.resolve(view), () => launchHeld.resolve());
  readSnapshot = () => { ownerEntered.resolve(); return ownerHeld.promise; };
  const owner = publisher.publishArea('docs');
  await ownerEntered.promise;
  view = snapshot({ [first]: 'launch', [second]: 'docs' });
  readSnapshot = () => view;
  beforePutReply = async id => { if (id === 'launch') { launchEntered.resolve(); await launchHeld.promise; } };
  const round = publisher.publishAll();
  await launchEntered.promise;
  view = snapshot({ [first]: 'launch', [third]: 'docs' });
  ownerHeld.resolve(view);
  await owner;
  launchHeld.resolve();
  await round;

  expect(requestIds()).toEqual([third]);
});

it('does not stop an owner-refreshed link after an older unshareable read completes', async () => {
  const entered = deferred<void>();
  const held = deferred<WorkViewSnapshot>();
  const unshareable = snapshot({});
  (unshareable.focusAreas as Array<{ focusAreaId: string; status: string }>).find(area => area.focusAreaId === 'docs')!.status = 'suggested';
  releases.push(() => held.resolve(unshareable));
  let reads = 0;
  readSnapshot = () => {
    if (++reads === 1) return unshareable;
    entered.resolve();
    return held.promise;
  };
  const round = publisher.publishAll();
  await entered.promise;
  view = snapshot({ [third]: 'docs' });
  readSnapshot = () => view;
  await publisher.publishArea('docs');
  held.resolve(unshareable);
  await round;

  expect(pages.has('docs')).toBe(true);
  expect(requestIds()).toEqual([third]);
});
