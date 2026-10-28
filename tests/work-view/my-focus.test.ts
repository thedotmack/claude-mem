import { describe, expect, it } from 'bun:test';
import { reduceWorkState } from '../../src/services/work-view/data-source.mjs';
import {
  anchorConversationKeyFor, buildFocusAreas, focusAreaRowFields, MY_FOCUS_LIST, navWordIn, ownerGoalsAreaRows, placeRequests, placementRowFields, routerFocusRows,
} from '../../src/services/work-view/my-focus.mjs';

const ANCHOR = JSON.stringify(['conversation', 'claude', 'session-1']);
const area = (focusAreaId: string, change: Record<string, unknown> = {}) => focusAreaRowFields({
  focusAreaId, name: focusAreaId.toUpperCase(), goal: null, status: 'suggested', priorityRank: null, ownerRank: null,
  source: 'seed', mergedInto: null, evidence: null, decidedBy: 'system', ...change,
} as any);
const placement = (focusAreaId: string, placedBy: 'router' | 'owner', anchorConversationKey = ANCHOR) =>
  placementRowFields({ anchorConversationKey, focusAreaId, placedBy });

type Row = { fields: Record<string, unknown>; at: number; device?: string; project?: string; list?: string };
function focus(rows: Row[]) {
  const entries = rows.map((row, index) => ({
    id: index + 1, project: row.project ?? 'home', list_name: row.list ?? MY_FOCUS_LIST, fields: JSON.stringify(row.fields),
    created_at_epoch: row.at, ...(row.device ? { origin_device_id: row.device, origin_local_id: String(index + 1) } : {}),
  }));
  return buildFocusAreas(reduceWorkState(entries, { currentProject: 'home', localDeviceId: 'this-device' }));
}
const areaById = (result: ReturnType<typeof focus>, id: string) => result.focusAreas.find(item => item.focusAreaId === id);

describe('buildFocusAreas', () => {
  it('lets the latest row win and keeps the id through a rename', () => {
    const result = focus([
      { fields: area('fa_viewer'), at: 1000 },
      { fields: area('fa_viewer', { name: 'Viewer', status: 'kept', decidedBy: 'owner' }), at: 2000 },
      { fields: area('fa_viewer', { name: 'My Work viewer', status: 'kept', decidedBy: 'owner' }), at: 3000 },
    ]);
    expect(result.focusAreas).toHaveLength(1);
    expect(areaById(result, 'fa_viewer')).toMatchObject({ name: 'My Work viewer', status: 'kept', decidedBy: 'owner', source: 'seed' });
  });

  it('never lets a system row override an area the owner decided, so a dismissed area stays dismissed', () => {
    const result = focus([
      { fields: area('fa_community'), at: 1000 },
      { fields: area('fa_community', { status: 'dismissed', decidedBy: 'owner' }), at: 2000 },
      // A later refresh proposes the same area again.
      { fields: area('fa_community', { name: 'Community again', status: 'suggested', source: 'clustering' }), at: 3000 },
    ]);
    expect(areaById(result, 'fa_community')).toMatchObject({ name: 'FA_COMMUNITY', status: 'dismissed', source: 'seed' });
  });

  it('never places a request in a dismissed area, even from a later router row', () => {
    const result = focus([
      { fields: area('fa_community'), at: 1000 },
      { fields: area('fa_community', { status: 'dismissed', decidedBy: 'owner' }), at: 2000 },
      { fields: placement('fa_community', 'router'), at: 3000 },
    ]);
    expect(result.focusAreaIdByAnchor.has(ANCHOR)).toBe(false);
  });

  it('lets an owner move beat a later router placement', () => {
    const result = focus([
      { fields: area('fa_viewer'), at: 1000 },
      { fields: area('fa_endless'), at: 1000 },
      { fields: placement('fa_viewer', 'router'), at: 2000 },
      { fields: placement('fa_endless', 'owner'), at: 3000 },
      { fields: placement('fa_viewer', 'router'), at: 4000 },
    ]);
    expect(result.focusAreaIdByAnchor.get(ANCHOR)).toBe('fa_endless');
    // A later owner move still wins over the earlier one.
    const moved = focus([
      { fields: area('fa_viewer'), at: 1000 },
      { fields: placement('fa_viewer', 'owner'), at: 2000 },
      { fields: placement('other', 'owner'), at: 3000 },
    ]);
    expect(moved.focusAreaIdByAnchor.get(ANCHOR)).toBe('other');
  });

  it('forwards placements of a merged area to the area it was merged into, through chains and loops', () => {
    const result = focus([
      { fields: area('fa_a'), at: 1000 },
      { fields: area('fa_b'), at: 1000 },
      { fields: area('fa_c'), at: 1000 },
      { fields: placement('fa_a', 'router'), at: 2000 },
      { fields: area('fa_a', { mergedInto: 'fa_b', decidedBy: 'owner' }), at: 3000 },
      { fields: area('fa_b', { mergedInto: 'fa_c', decidedBy: 'owner' }), at: 4000 },
    ]);
    expect(result.focusAreaIdByAnchor.get(ANCHOR)).toBe('fa_c');
    expect(areaById(result, 'fa_a')!.mergedInto).toBe('fa_b');
    // Two devices merged each into the other: no live area, so the request is not sorted until one merge is undone.
    const loop = focus([
      { fields: area('fa_a'), at: 1000 },
      { fields: area('fa_b'), at: 1000 },
      { fields: placement('fa_a', 'router'), at: 2000 },
      { fields: area('fa_a', { mergedInto: 'fa_b', decidedBy: 'owner' }), at: 3000, device: 'laptop' },
      { fields: area('fa_b', { mergedInto: 'fa_a', decidedBy: 'owner' }), at: 3000, device: 'desktop' },
    ]);
    expect(loop.focusAreaIdByAnchor.has(ANCHOR)).toBe(false);
    // Merged into an area this device has not received yet: not sorted, never the merged area itself.
    const pending = focus([
      { fields: area('fa_a'), at: 1000 },
      { fields: placement('fa_a', 'router'), at: 2000 },
      { fields: area('fa_a', { mergedInto: 'fa_unseen', decidedBy: 'owner' }), at: 3000 },
    ]);
    expect(pending.focusAreaIdByAnchor.has(ANCHOR)).toBe(false);
  });

  it('lets system rows apply again after the owner hands an area back to suggestions', () => {
    const result = focus([
      { fields: area('fa_viewer', { name: 'Viewer' }), at: 1000 },
      { fields: area('fa_viewer', { name: 'Viewer', status: 'dismissed', decidedBy: 'owner' }), at: 2000 },
      { fields: area('fa_viewer', { name: 'Ignored while dismissed' }), at: 3000 },
      { fields: area('fa_viewer', { name: 'Viewer', status: 'suggested', decidedBy: 'owner-restore' }), at: 4000 },
      { fields: area('fa_viewer', { name: 'Viewer, re-mined', goal: 'Show the work.' }), at: 5000 },
    ]);
    expect(areaById(result, 'fa_viewer')).toMatchObject({ name: 'Viewer, re-mined', goal: 'Show the work.', status: 'suggested', decidedBy: 'system' });
  });

  it('lets the router re-place a request once the owner\'s area is dismissed or merged into a dismissed one', () => {
    const dismissed = focus([
      { fields: area('fa_viewer'), at: 1000 },
      { fields: area('fa_endless'), at: 1000 },
      { fields: placement('fa_viewer', 'owner'), at: 2000 },
      { fields: area('fa_viewer', { status: 'dismissed', decidedBy: 'owner' }), at: 3000 },
      { fields: placement('fa_endless', 'router'), at: 4000 },
    ]);
    expect(dismissed.focusAreaIdByAnchor.get(ANCHOR)).toBe('fa_endless');
    const mergedIntoDismissed = focus([
      { fields: area('fa_viewer'), at: 1000 },
      { fields: area('fa_endless'), at: 1000 },
      { fields: area('fa_community'), at: 1000 },
      { fields: placement('fa_viewer', 'owner'), at: 2000 },
      { fields: area('fa_viewer', { mergedInto: 'fa_community', decidedBy: 'owner' }), at: 3000 },
      { fields: area('fa_community', { status: 'dismissed', decidedBy: 'owner' }), at: 4000 },
      { fields: placement('fa_endless', 'router'), at: 5000 },
    ]);
    expect(mergedIntoDismissed.focusAreaIdByAnchor.get(ANCHOR)).toBe('fa_endless');
  });

  it('replays rows from two devices in write order, not arrival order, across home projects', () => {
    // Same millisecond: the device id breaks the tie, so 'desktop' replays before 'laptop' on every device.
    const rows: Row[] = [
      { fields: area('fa_viewer', { name: 'From laptop', decidedBy: 'owner' }), at: 5000, device: 'laptop', project: 'laptop-home' },
      { fields: area('fa_viewer', { name: 'From desktop', decidedBy: 'owner' }), at: 5000, device: 'desktop', project: 'desktop-home' },
      { fields: area('fa_viewer', { name: 'Oldest', decidedBy: 'owner' }), at: 4000, device: 'desktop', project: 'desktop-home' },
    ];
    expect(areaById(focus(rows), 'fa_viewer')!.name).toBe('From laptop');
    expect(areaById(focus([...rows].reverse()), 'fa_viewer')!.name).toBe('From laptop');
  });

  it('orders areas by the owner\'s rank, then the suggested priority', () => {
    const result = focus([
      { fields: area('fa_a', { priorityRank: 1 }), at: 1000 },
      { fields: area('fa_b', { priorityRank: 2 }), at: 1000 },
      { fields: area('fa_c', { priorityRank: 3, ownerRank: 1, decidedBy: 'owner' }), at: 2000 },
    ]);
    expect(result.focusAreas.map(item => item.focusAreaId)).toEqual(['fa_c', 'fa_a', 'fa_b']);
  });

  it('throws on a row it cannot read instead of guessing', () => {
    const raw = (fields: Record<string, unknown>) => () => focus([{ fields: { task: 'Focus area: fa_a', focus_area_id: 'fa_a', name: 'A', status: 'suggested', source: 'seed', decided_by: 'system', ...fields }, at: 1000 }]);
    expect(raw({})).not.toThrow();
    expect(raw({ status: 'archived' })).toThrow('unknown status');
    expect(raw({ source: 'gut-feeling' })).toThrow('unknown source');
    expect(raw({ decided_by: 'someone' })).toThrow('unknown writer');
    expect(raw({ name: null })).toThrow('has no name');
    expect(raw({ task: 'Focus area: other', focus_area_id: 'other' })).toThrow('reserved id');
    expect(() => focus([{ fields: { task: `Placement: ${ANCHOR}`, anchor_conversation_key: ANCHOR, focus_area_id: 'other', placed_by: 'guess' }, at: 1000 }])).toThrow('unknown writer');
  });

  it('ignores other lists and refuses rows that cannot be saved', () => {
    expect(focus([{ fields: area('fa_a'), at: 1000, list: 'my-rules' }]).focusAreas).toEqual([]);
    expect(() => area('other')).toThrow();
    expect(() => area('fa_a', { status: 'archived' })).toThrow();
    expect(() => area('fa_a', { evidence: 'x'.repeat(2000) })).toThrow(RangeError);
    expect(() => placementRowFields({ anchorConversationKey: '', focusAreaId: 'fa_a', placedBy: 'owner' })).toThrow();
  });

  it('fails loudly when the row history was cut', () => {
    const state = reduceWorkState([
      { id: 1, project: 'home', list_name: MY_FOCUS_LIST, fields: JSON.stringify(area('fa_a')), created_at_epoch: 1 },
      { id: 2, project: 'home', list_name: MY_FOCUS_LIST, fields: JSON.stringify(area('fa_b')), created_at_epoch: 2 },
    ], { currentProject: 'home', eventLimit: 1 });
    expect(() => buildFocusAreas(state)).toThrow('events were cut');
  });
});

describe('placeRequests', () => {
  it('keys a grouped request by its group anchor and an ungrouped one by its own conversation', () => {
    const groupAnchor = JSON.stringify(['conversation', 'claude', 'anchor']);
    const ledger = { groups: { groups: { g_1: { anchor: groupAnchor } } } };
    const grouped = { id: '["overall-request","g_1"]', groupId: 'g_1', conversationKey: ANCHOR };
    const single = { id: ANCHOR, groupId: null, conversationKey: ANCHOR };
    expect(anchorConversationKeyFor(grouped, ledger)).toBe(groupAnchor);
    expect(anchorConversationKeyFor(single, ledger)).toBe(ANCHOR);
    // A group this device's ledger does not hold yet falls back to the request's own conversation.
    expect(anchorConversationKeyFor({ groupId: 'g_missing', conversationKey: ANCHOR }, ledger)).toBe(ANCHOR);
    expect(anchorConversationKeyFor(grouped, null)).toBe(ANCHOR);
    const placed = placeRequests([grouped, single, { id: 'x', groupId: null, conversationKey: null }], new Map([[groupAnchor, 'fa_viewer']]), ledger);
    expect(placed[0]).toMatchObject({ anchorConversationKey: groupAnchor, focusAreaId: 'fa_viewer' });
    // Not sorted yet: no focusAreaId at all.
    expect('focusAreaId' in placed[1]).toBe(false);
    expect(placed[2].anchorConversationKey).toBeNull();
  });
});

describe('ownerGoalsAreaRows', () => {
  const mined = (matches: string | null, change: Record<string, unknown> = {}) => ({ name: 'Viewer', goal: 'A live view of my work.', rank: 2, matches, evidence: 'From your prompts.', ...change });
  const saved = (rows: Row[]) => focus(rows).focusAreas;

  it('fills a missing goal on a matched suggestion nobody decided, and never replaces a goal or the name', () => {
    // Hosted setup saved this area without a goal.
    const goalless = saved([{ fields: area('fa_hosted', { name: 'Ship the viewer', source: 'owner-goals', priorityRank: 1 }), at: 1000 }]);
    const { rows, focusAreaIds } = ownerGoalsAreaRows([mined('fa_hosted')], goalless);
    expect(focusAreaIds).toEqual(['fa_hosted']);
    const after = saved([{ fields: area('fa_hosted', { name: 'Ship the viewer', source: 'owner-goals', priorityRank: 1 }), at: 1000 }, ...rows.map((fields, index) => ({ fields, at: 2000 + index }))]);
    expect(after[0]).toMatchObject({ name: 'Ship the viewer', goal: 'A live view of my work.', priorityRank: 2, decidedBy: 'system' });
    // An existing goal stays; same rank and a goal means nothing to write.
    expect(ownerGoalsAreaRows([mined('fa_hosted', { goal: 'Something else.' })], after).rows).toEqual([]);
    // An area the owner decided gets no goal from a run, even when it has none.
    const kept = saved([{ fields: area('fa_hosted', { status: 'kept', decidedBy: 'owner' }), at: 1000 }]);
    expect(ownerGoalsAreaRows([mined('fa_hosted')], kept).rows).toEqual([]);
  });

  it('a match to an area the owner merged away answers that area\'s own id, so the next unchanged save is still accepted', () => {
    const areas = saved([
      { fields: area('fa_target', { status: 'kept', decidedBy: 'owner' }), at: 1000 },
      { fields: area('fa_middle', { mergedInto: 'fa_target', decidedBy: 'owner' }), at: 1000 },
      { fields: area('fa_old', { mergedInto: 'fa_middle', decidedBy: 'owner' }), at: 1000 },
    ]);
    // The owner merged fa_old into fa_target (through fa_middle). Two mined items, one per saved area.
    const first = ownerGoalsAreaRows([mined('fa_old'), mined('fa_target', { name: 'Target' })], areas);
    expect(first).toEqual({ rows: [], focusAreaIds: ['fa_old', 'fa_target'] });
    // The next save passes each item's saved id back as `matches` (refresh-task goalsJson): still one per saved area.
    expect(ownerGoalsAreaRows(first.focusAreaIds.map((matches) => mined(matches)), areas).focusAreaIds).toEqual(['fa_old', 'fa_target']);
  });
  it('refuses a new mined area named like a nav item, with the rule the seed and rename use', () => {
    expect(() => ownerGoalsAreaRows([mined(null, { name: 'Other things' })], [], () => 'fa_new')).toThrow(/focus_areas\[0\] is named "Other things", which reuses the nav word "other"/);
    expect(ownerGoalsAreaRows([mined(null, { name: 'Work viewer' })], [], () => 'fa_new').focusAreaIds).toEqual(['fa_new']);
  });
});

describe('nav words', () => {
  it('matches whole nav labels only, so ordinary names stay usable', () => {
    for (const [name, label] of [['My Work', 'my work'], ['Ship the My Work viewer', 'my work'], ['other', 'other'], ['Past focus notes', 'past focus'], ['Monitor', 'monitor'], ['Steer-ing', 'steer'], ['  SUGGESTED ', 'suggested']]) {
      expect(navWordIn(name)).toBe(label);
    }
    for (const name of ['Work viewer', 'Network', 'My laptop', 'Focus mode', 'Others', 'Monitoring', 'Rules engine']) expect(navWordIn(name)).toBeNull();
  });

  it('refuses a proposed area named like a nav item', () => {
    const proposal = { kind: 'new', name: 'Suggested fixes', goal: 'g', about: 'a', evidence: 'e', sameAs: null, requests: [] };
    expect(() => routerFocusRows({ placements: [], proposals: [proposal] }, [], () => 'fa_new')).toThrow(/proposals\[0\] is named "Suggested fixes", which reuses the nav word "suggested"/);
    expect(routerFocusRows({ placements: [], proposals: [{ ...proposal, name: 'Fixes' }] }, [], () => 'fa_new').focusAreaIds).toEqual(['fa_new']);
  });
});
