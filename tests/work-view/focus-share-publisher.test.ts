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
  const sent: Array<{ id: string; page: any; create?: boolean }> = [];
  const stopped: string[] = [];
  const entry = (id: string): FocusShareEntry => ({ token: 'a'.repeat(32), url: `https://cmem.ai/focus/${id}`, sharedAt: 'x', publishedAt: null, pageHash: null });
  return {
    sent,
    stopped,
    connected: () => true,
    list: () => Object.fromEntries(shared.filter(id => !stopped.includes(id)).map(id => [id, entry(id)])),
    publish: async (id: string, page: unknown, options?: { create?: boolean }) => { sent.push({ id, page, create: options?.create }); return publish ? publish(id, page) : { entry: entry(id), sent: true }; },
    stop: async (id: string) => { stopped.push(id); },
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
    expect(fake.sent[0].create).toBe(false);
    expect(fake.sent[0].page.requests.map((request: { id: string }) => request.id)).toEqual([first]);

    // A request placed in the area later is on the next round, with no viewer open; one moved out is gone.
    view = snapshot({ [second]: 'launch', [third]: 'launch' });
    await publisher.publishAll();
    expect(fake.sent[1].page.requests.map((request: { id: string }) => request.id).sort()).toEqual([second, third].sort());
  });

  it('stops the link of an area merged away, dismissed or handed back to suggestions', async () => {
    const fake = shares(['idea', 'docs']);
    const merged = snapshot({});
    (merged.focusAreas as any[])[1] = { ...area('docs'), mergedInto: 'launch' };
    const publisher = new FocusSharePublisher({ shares: fake, snapshot: () => merged, now: () => NOW, everyMs: 0 });
    await publisher.publishAll();
    expect(fake.sent).toHaveLength(0);
    expect(fake.stopped.sort()).toEqual(['docs', 'idea']);
    await expect(publisher.publishArea('idea')).rejects.toThrow(NOT_SHAREABLE);
  });

  it('keeps the link when the owner undoes the merge while the round is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fake = shares(['launch', 'docs'], async (id) => { await gate; return { entry: { token: 'a'.repeat(32), url: `https://cmem.ai/focus/${id}`, sharedAt: 'x', publishedAt: 'y', pageHash: null }, sent: true }; });
    const merged = snapshot({ [first]: 'launch' });
    (merged.focusAreas as any[])[1] = { ...area('docs'), mergedInto: 'launch' };
    let view = merged;
    const publisher = new FocusSharePublisher({ shares: fake, snapshot: () => view, now: () => NOW, everyMs: 0 });
    const round = publisher.publishAll();
    await Promise.resolve();
    view = snapshot({ [first]: 'launch' }); // merge undone while launch's update waits on cmem.ai
    release();
    await round;
    expect(fake.stopped).toEqual([]);
  });

  it('keeps the last page and says why when a shared area is missing from the read', async () => {
    const fake = shares(['gone']);
    const publisher = new FocusSharePublisher({ shares: fake, snapshot: () => snapshot({}), now: () => NOW, everyMs: 0 });
    await publisher.publishAll();
    expect(fake.sent).toHaveLength(0);
    expect(fake.stopped).toEqual([]);
    expect(publisher.errorFor('gone')).toContain(NOT_SHAREABLE);
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
