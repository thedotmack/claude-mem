import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FocusShareError, type FocusShareEntry } from '../../src/services/work-view/focus-share.js';
import { FocusSharePublisher, NOT_SHAREABLE } from '../../src/services/work-view/focus-share-publisher.js';
import type { WorkViewSnapshot } from '../../src/services/work-view/data-source.mjs';

// The trimmed real worker snapshot the viewer's mapper tests use, with focus areas placed on it.
const fixture = JSON.parse(readFileSync(join(import.meta.dir, '../../src/ui/my-work/test-fixtures/work-view-snapshot.trimmed.json'), 'utf8'));
const NOW = Date.parse(fixture.generatedAt);
const area = (focusAreaId: string, status = 'kept') => ({
  focusAreaId, name: focusAreaId, goal: null, status, priorityRank: null, ownerRank: null, source: 'owner-goals',
  mergedInto: null, evidence: null, decidedBy: 'owner', savedAt: null,
});
function snapshot(placements: Record<string, string>, extra: Record<string, unknown> = {}): WorkViewSnapshot {
  const humanRequests = fixture.humanRequests.map((request: { id: string }) => placements[request.id] ? { ...request, focusAreaId: placements[request.id] } : request);
  return { ...fixture, focusAreas: [area('launch'), area('docs'), area('idea', 'suggested')], humanRequests, ...extra };
}
const [first, second, third] = fixture.humanRequests.map((request: { id: string }) => request.id);

/** A FocusShares stand-in: records each page it is handed and answers like the real one. */
function shares(shared: string[], publish?: (id: string, page: any) => Promise<{ entry: FocusShareEntry; sent: boolean }>) {
  const sent: Array<{ id: string; page: any }> = [];
  const entry = (id: string): FocusShareEntry => ({ token: 'a'.repeat(32), url: `https://cmem.ai/focus/${id}`, sharedAt: 'x', publishedAt: null, pageHash: null });
  return {
    sent,
    connected: () => true,
    list: () => Object.fromEntries(shared.map(id => [id, entry(id)])),
    publish: async (id: string, page: unknown) => { sent.push({ id, page }); return publish ? publish(id, page) : { entry: entry(id), sent: true }; },
  };
}

describe('FocusSharePublisher', () => {
  it('publishes each shared area from the work view, with only the requests placed in it', async () => {
    let view = snapshot({ [first]: 'launch', [second]: 'docs' });
    const fake = shares(['launch']);
    const publisher = new FocusSharePublisher({ shares: fake, snapshot: () => view, now: () => NOW, everyMs: 0 });
    await publisher.publishAll();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].id).toBe('launch');
    expect(fake.sent[0].page.requests.map((request: { id: string }) => request.id)).toEqual([first]);

    // A request placed in the area later is on the next round, with no viewer open; one moved out is gone.
    view = snapshot({ [second]: 'launch', [third]: 'launch' });
    await publisher.publishAll();
    expect(fake.sent[1].page.requests.map((request: { id: string }) => request.id).sort()).toEqual([second, third].sort());
  });

  it('keeps the last page and says why when an area can no longer be shared', async () => {
    const fake = shares(['idea']);
    const publisher = new FocusSharePublisher({ shares: fake, snapshot: () => snapshot({}), now: () => NOW, everyMs: 0 });
    await publisher.publishAll();
    expect(fake.sent).toHaveLength(0);
    expect(publisher.errorFor('idea')).toContain(NOT_SHAREABLE);
    await expect(publisher.publishArea('idea')).rejects.toThrow(NOT_SHAREABLE);
  });

  it('remembers a failed update until one goes through, and forgets a link stopped elsewhere', async () => {
    let answer: 'fail' | 'ok' | 'gone' = 'fail';
    const fake = shares(['launch'], async (id) => {
      if (answer === 'fail') throw new FocusShareError('cmem.ai could not be reached.', 502);
      if (answer === 'gone') throw new FocusShareError('This page was stopped.', 410);
      return { entry: { token: 'a'.repeat(32), url: `https://cmem.ai/focus/${id}`, sharedAt: 'x', publishedAt: 'y', pageHash: null }, sent: true };
    });
    const publisher = new FocusSharePublisher({ shares: fake, snapshot: () => snapshot({ [first]: 'launch' }), now: () => NOW, everyMs: 0 });
    await publisher.publishAll();
    expect(publisher.errorFor('launch')).toBe('cmem.ai could not be reached.');
    answer = 'ok';
    await publisher.publishAll();
    expect(publisher.errorFor('launch')).toBeNull();
    answer = 'gone';
    await publisher.publishAll();
    expect(publisher.errorFor('launch')).toBeNull();
  });

  it('sends nothing while local work cannot be read, or nothing is shared', async () => {
    const offline = shares(['launch']);
    const publisher = new FocusSharePublisher({ shares: offline, snapshot: () => snapshot({ [first]: 'launch' }, { source: { ...fixture.source, connected: false } }), now: () => NOW, everyMs: 0 });
    await publisher.publishAll();
    expect(offline.sent).toHaveLength(0);
    expect(publisher.errorFor('launch')).toContain('couldn’t be read');

    let reads = 0;
    const idle = new FocusSharePublisher({ shares: shares([]), snapshot: () => { reads++; return snapshot({}); }, now: () => NOW, everyMs: 0 });
    await idle.publishAll();
    expect(reads).toBe(0);
  });

  it('joins a round already running instead of starting a second', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fake = shares(['launch'], async (id) => { await gate; return { entry: { token: 'a'.repeat(32), url: `https://cmem.ai/focus/${id}`, sharedAt: 'x', publishedAt: 'y', pageHash: null }, sent: true }; });
    const publisher = new FocusSharePublisher({ shares: fake, snapshot: () => snapshot({ [first]: 'launch' }), now: () => NOW, everyMs: 0 });
    const a = publisher.publishAll();
    const b = publisher.publishAll();
    release();
    await Promise.all([a, b]);
    expect(fake.sent).toHaveLength(1);
  });
});
