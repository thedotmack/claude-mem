import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FocusShares } from '../../src/services/work-view/focus-share.js';
import { FocusSharePublisher } from '../../src/services/work-view/focus-share-publisher.js';
import { sampleSource } from '../../src/ui/my-work/src/live/sample-source.ts';
import { toSharedFocusPage } from '../../src/ui/my-work/src/live/to-shared-focus.ts';
import { NEXT_STEP_NOT_RECORDED, NO_WORK_YET, toWorkModel } from '../../src/ui/my-work/src/live/to-work-model.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const SECRET = 'Send the confidential acquisition plan to Cedar Partners';
const fixture = JSON.parse(readFileSync(join(import.meta.dir, '../../src/ui/my-work/test-fixtures/work-view-snapshot.trimmed.json'), 'utf8'));
const NOW = Date.parse(fixture.generatedAt);

test('a copied prompt in a display summary or next step stays out of the shared page', async () => {
  const model = await sampleSource.loadWorkModel();
  const request = { ...model.requests[0], summary: SECRET, next: { who: 'bot' as const, text: SECRET }, prompts: [{ at: 'now', quote: `${SECRET}.` }] };
  const page = toSharedFocusPage({ ...model, requests: [request] }, 'fa-viewer', NOW)!;
  expect(page.requests[0].summary).toBeNull();
  expect(page.requests[0].next).toEqual({ who: 'bot', text: NEXT_STEP_NOT_RECORDED });
  expect(JSON.stringify(page)).not.toContain('Cedar Partners');
  expect(request.summary).toBe(SECRET);
  expect(request.next.text).toBe(SECRET);
});

for (const blocked of [false, true]) test(`publication checks the full prompt before quotes are shortened (${blocked ? 'blocked review' : 'human copy'})`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'focus-echo-'));
  cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
  const base = fixture.humanRequests[0];
  const raw = { ...base, focusAreaId: 'launch', groupId: blocked ? 'group-launch' : undefined,
    title: 'Project planning', titleSource: 'request-group', lifecycle: null, completedAtEpoch: null,
    original: { ...base.original, text: `${'Background details. '.repeat(40)}${SECRET}.` }, scopeUpdates: [],
    items: base.items.map((item: any) => ({ ...item, kind: 'work-state', status: blocked ? 'blocked' : 'doing' })),
    humanCopy: { state: 'current', title: 'Project planning', summary: SECRET, next: SECRET, workstreams: [] },
    progress: blocked ? { state: 'working', percent: 40, checkedAt: new Date(NOW).toISOString(), summary: SECRET, readings: [] } : null,
  };
  const view = { ...fixture, humanRequests: [raw], focusAreas: [{ focusAreaId: 'launch', name: 'Launch planning',
    goal: null, status: 'kept', priorityRank: null, ownerRank: null, source: 'owner-goals', mergedInto: null, evidence: null, decidedBy: 'owner', savedAt: null }] };
  const local = toWorkModel(view, NOW);
  expect(local.requestReadErrors).toEqual([]);
  expect(local.requests[0].summary).toBe(SECRET);
  expect(local.requests[0].next.text).toContain(SECRET);
  expect(local.requests[0].prompts[0].quote).not.toContain('Cedar Partners');

  const received: any[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    received.push(await request.json());
    return Response.json({ token: 'p'.repeat(32), url: `${new URL(request.url).origin}/focus/${'p'.repeat(32)}` });
  } });
  cleanups.push(() => server.stop(true));
  const shares = new FocusShares({ origin: () => `http://127.0.0.1:${server.port}`, credentials: () => ({ token: 'local-test-token', userId: 'local-test-user' }), registryPath: join(directory, 'shares.json') });
  const publisher = new FocusSharePublisher({ shares, snapshot: () => view, now: () => NOW, everyMs: 0 });
  cleanups.push(() => publisher.close());
  await publisher.publishArea('launch');
  expect(received).toHaveLength(1);
  expect(JSON.stringify(received[0])).not.toContain('Cedar Partners');
  expect(received[0].snapshot.requests[0].summary).toBeNull();
  expect(received[0].snapshot.requests[0].next.text).toBe(NEXT_STEP_NOT_RECORDED);
});

test('independently written summaries and next steps remain useful on the shared page', async () => {
  const model = await sampleSource.loadWorkModel();
  const request = { ...model.requests[0], summary: 'The plan is ready for review.', next: { who: 'human' as const, text: 'Review the delivery checklist' }, prompts: [{ at: 'now', quote: SECRET }] };
  const shared = toSharedFocusPage({ ...model, requests: [request] }, 'fa-viewer', NOW)!.requests[0];
  expect(shared.summary).toBe(request.summary);
  expect(shared.next).toEqual(request.next);
});

// Decision G3: the model carries a missing step as a value, and My Work leaves the line out. The page cmem.ai draws still
// needs a line (its snapshot schema takes next.text as at least one character), so the shared page words the value with
// the same English it showed before 16.0.0, and an older worker's filler reads the same way.
test('a request with no recorded step publishes the shared page\'s words for why, never an empty line', async () => {
  const model = await sampleSource.loadWorkModel();
  const cases = [
    [{ who: 'bot' as const, missing: 'not-recorded' as const }, NEXT_STEP_NOT_RECORDED],
    [{ who: 'human' as const, missing: 'no-agent-work' as const }, NO_WORK_YET],
    [{ who: 'bot' as const, text: NEXT_STEP_NOT_RECORDED }, NEXT_STEP_NOT_RECORDED],
    [{ who: 'bot' as const, text: NO_WORK_YET }, NO_WORK_YET],
  ] as const;
  for (const [next, words] of cases) {
    const request = { ...model.requests[0], next };
    const shared = toSharedFocusPage({ ...model, requests: [request] }, 'fa-viewer', NOW)!.requests[0];
    expect(shared.next).toEqual({ who: next.who, text: words });
  }
});

// The model now carries step kinds and durations as values (data.ts NextStepKind, Request.runningForMs). The shared page
// still publishes the English the mapper wrote before 16.0.0, word for word, so its payload is the one it was. The
// blocked request with no step is the case a check found changed ("Unblock: " had been dropped).
test('the shared page publishes the step kinds and durations in the same English as before 16.0.0', async () => {
  const model = await sampleSource.loadWorkModel();
  const steps = [
    [{ who: 'human' as const, kind: 'ship' as const }, 'Ship it'],
    [{ who: 'human' as const, kind: 'unblock' as const, text: 'Pick which forecast to keep' }, 'Unblock: Pick which forecast to keep'],
    [{ who: 'human' as const, kind: 'unblock' as const, missing: 'not-recorded' as const }, `Unblock: ${NEXT_STEP_NOT_RECORDED}`],
    [{ who: 'bot' as const, text: 'Finish the My Rules screens' }, 'Finish the My Rules screens'],
  ] as const;
  for (const [next, words] of steps) {
    const shared = toSharedFocusPage({ ...model, requests: [{ ...model.requests[0], next }] }, 'fa-viewer', NOW)!.requests[0];
    expect(shared.next).toEqual({ who: next.who, text: words });
  }
  const minute = 60_000;
  const durations = [[30_000, 'Just started'], [42 * minute, '42 min'], [2 * 60 * minute, '2 hr'], [24 * 60 * minute, '1 day'], [3 * 24 * 60 * minute, '3 days'], [null, 'Not recorded']] as const;
  for (const [runningForMs, words] of durations) {
    const shared = toSharedFocusPage({ ...model, requests: [{ ...model.requests[0], runningForMs }] }, 'fa-viewer', NOW)!.requests[0];
    expect(shared.runningFor).toBe(words);
  }
});
