import { afterEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { reduceWorkState } from '../../src/services/work-view/data-source.mjs';
import { buildFocusAreas, placementRowFields } from '../../src/services/work-view/my-focus.mjs';
import { focusBasis, focusInput, groupIdFor, otherInput, validateFocusAnswer } from '../../src/services/work-view/request-groups.mjs';

const DEVICE = 'local';
const key = (session: string) => JSON.stringify(['conversation', 'claude', session]);
let store: SessionStore;
afterEach(() => store?.close());

function fixture(count = 120) {
  store = new SessionStore(':memory:');
  const ledger = { groups: { groups: {} as Record<string, any>, conversations: {} as Record<string, string> }, progress: {}, agentWrittenPromptIds: new Set<number>() };
  const groupIds: string[] = [];
  for (let index = 0; index < count; index++) {
    const anchor = key(`session-${index}-0`);
    const groupId = groupIdFor(anchor);
    groupIds.push(groupId);
    ledger.groups.groups[groupId] = { anchor, title: `Feature ${index}`, projectRoot: 'repo', anchorAsk: { text: `Implement feature ${index}` } };
    // Stored insertion order differs from the stable order used by fingerprints
    // and the opening asks shown to the focus step.
    for (const member of [2, 0, 1]) ledger.groups.conversations[key(`session-${index}-${member}`)] = groupId;
  }
  const entries = groupIds.map((groupId, index) => ({
    id: index + 1, project: 'repo', list_name: 'my-focus', created_at_epoch: index + 1,
    origin_device_id: DEVICE, origin_local_id: String(index + 1),
    fields: JSON.stringify(placementRowFields({ anchorConversationKey: ledger.groups.groups[groupId].anchor,
      focusAreaId: 'other', placedBy: 'router', basis: focusBasis(ledger, groupId), evidence: 'No matching area.' })),
  }));
  const focus = buildFocusAreas(reduceWorkState(entries, { currentProject: 'repo', localDeviceId: DEVICE }), { localDeviceId: DEVICE });
  let membershipReads = 0;
  ledger.groups.conversations = new Proxy(ledger.groups.conversations, {
    get(target, property, receiver) {
      if (typeof property === 'string' && Object.hasOwn(target, property)) membershipReads++;
      return Reflect.get(target, property, receiver);
    },
  });
  return { ledger, focus, groupIds, membershipReads: () => membershipReads, resetReads: () => { membershipReads = 0; } };
}

describe('focus request membership reads', () => {
  it('checks current placements without rereading every membership for each request', () => {
    const { ledger, focus, membershipReads } = fixture();
    const result = focusInput(ledger, focus, DEVICE, store.db);
    expect(result.requests).toEqual([]);
    expect(result.remaining).toBe(0);
    expect(membershipReads()).toBeLessThanOrEqual(Object.keys(ledger.groups.conversations).length * 3);
  });

  it('shares membership reads across Other fingerprints and request records', () => {
    const { ledger, focus, groupIds, membershipReads } = fixture();
    const result = otherInput(ledger, focus, DEVICE, store.db);
    expect(result.due).toBe(true);
    expect(result.other.map(request => request.groupId)).toEqual(groupIds);
    expect(result.other.every(request => request.conversations === 3)).toBe(true);
    expect(membershipReads()).toBeLessThanOrEqual(Object.keys(ledger.groups.conversations).length * 3);
  });

  it('keeps placement and proposal fingerprints while reading memberships once per answer', () => {
    const { ledger, focus, groupIds, membershipReads, resetReads } = fixture();
    const input = otherInput(ledger, focus, DEVICE, store.db);
    const expected = groupIds.map(groupId => ({ anchorConversationKey: ledger.groups.groups[groupId].anchor, basis: focusBasis(ledger, groupId) }));
    resetReads();
    const placements = validateFocusAnswer({ placements: input.other.map(request => ({ anchor: request.anchor, focusAreaId: 'other', evidence: 'Still no matching area.' })), proposals: [] },
      { areas: input.areas, dismissed: input.dismissed, requests: input.other, remaining: 0 }, ledger);
    expect(placements.placements?.map(({ anchorConversationKey, basis }) => ({ anchorConversationKey, basis }))).toEqual(expected);
    expect(membershipReads()).toBeLessThanOrEqual(Object.keys(ledger.groups.conversations).length * 3);

    resetReads();
    const proposal = validateFocusAnswer({ placements: [], proposals: [{ kind: 'new', name: 'Features', goal: 'Implement related features.', about: 'Feature requests.',
      evidence: 'They share an implementation goal.', sameAs: null, anchors: input.other.slice(0, 2).map(request => request.anchor) }] }, input, ledger, { other: true });
    expect(proposal.proposals?.[0].requests).toEqual(expected.slice(0, 2));
    expect(proposal.otherPassHash).toMatch(/^[a-f0-9]{16}$/);
    expect(membershipReads()).toBeLessThanOrEqual(Object.keys(ledger.groups.conversations).length * 3);
  });

  it('does not cache membership or title changes across calls and preserves sorted opening asks', () => {
    const { ledger, focus, groupIds } = fixture(2);
    for (const member of [2, 0, 1]) {
      const contentSession = `session-0-${member}`;
      const ask = `Implement feature zero step ${member}`;
      const sessionId = store.createSDKSession(contentSession, 'repo', ask);
      store.saveUserPrompt(contentSession, 1, ask, sessionId);
    }
    expect(focusInput(ledger, focus, DEVICE, store.db).requests).toEqual([]);
    ledger.groups.conversations[key('session-1-2')] = groupIds[0];
    const changed = focusInput(ledger, focus, DEVICE, store.db);
    expect(changed.requests.map(request => request.conversations)).toEqual([4, 2]);
    expect(changed.requests[0].conversationAsks).toEqual([0, 1, 2].map(member => `Implement feature zero step ${member}`));

    for (const groupId of groupIds) focus.placementsByAnchor.get(ledger.groups.groups[groupId].anchor)!.router!.basis = focusBasis(ledger, groupId);
    expect(focusInput(ledger, focus, DEVICE, store.db).requests).toEqual([]);
    ledger.groups.groups[groupIds[0]].title = 'Revised feature';
    const renamed = focusInput(ledger, focus, DEVICE, store.db);
    expect(renamed.requests.map(request => request.title)).toEqual(['Revised feature']);
  });

  it('preserves Other pass hashes after reordering the stored membership object', () => {
    const { ledger, focus } = fixture(4);
    const before = otherInput(ledger, focus, DEVICE, store.db);
    const saved = validateFocusAnswer({ placements: [], proposals: [] }, before, ledger, { other: true });
    const recorded = { ...focus, otherPassHash: saved.otherPassHash! };
    expect(otherInput(ledger, recorded, DEVICE, store.db).due).toBe(false);
    ledger.groups.conversations = Object.fromEntries(Object.entries(ledger.groups.conversations).reverse());
    expect(otherInput(ledger, recorded, DEVICE, store.db)).toEqual({ ...before, due: false });
  });
});
