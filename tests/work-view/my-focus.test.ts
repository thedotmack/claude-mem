import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reduceWorkState } from '../../src/services/work-view/data-source.mjs';
import { doneAtAfterChange } from '../../src/services/work-view/focus-done-date.mjs';
import {
  anchorConversationKeyFor, buildFocusAreas, focusAreaRowFields, MY_FOCUS_LIST, navWordIn, ownerGoalsAreaRows, placeRequests, placementRowFields, routerFocusRows,
  subFocusPlacementRowFields, subFocusRowFields,
} from '../../src/services/work-view/my-focus.mjs';

const ANCHOR = JSON.stringify(['conversation', 'claude', 'session-1']);
const area = (focusAreaId: string, change: Record<string, unknown> = {}) => focusAreaRowFields({
  focusAreaId, name: focusAreaId.toUpperCase(), goal: null, status: 'suggested', priorityRank: null, ownerRank: null,
  source: 'seed', mergedInto: null, evidence: null, decidedBy: 'system', ...change,
} as any);
const placement = (focusAreaId: string, placedBy: 'router' | 'owner', anchorConversationKey = ANCHOR) =>
  placementRowFields({ anchorConversationKey, focusAreaId, placedBy });

type Row = { fields: Record<string, unknown>; at: number; device?: string; project?: string; list?: string };
function focus(rows: Row[], options: { localDeviceId?: string } = {}) {
  const entries = rows.map((row, index) => ({
    id: index + 1, project: row.project ?? 'home', list_name: row.list ?? MY_FOCUS_LIST, fields: JSON.stringify(row.fields),
    created_at_epoch: row.at, ...(row.device ? { origin_device_id: row.device, origin_local_id: String(index + 1) } : {}),
  }));
  return buildFocusAreas(reduceWorkState(entries, { currentProject: 'home', localDeviceId: 'this-device' }), options);
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

  it('dates a done area by the row that marked it done: a rename or goal edit on a later day keeps that day', () => {
    const day = (date: string) => Date.parse(`${date}T12:00:00Z`);
    const result = focus([
      { fields: area('fa_fixes', { name: 'Plugin fixes', status: 'kept', decidedBy: 'owner' }), at: day('2026-10-10') },
      { fields: area('fa_fixes', { name: 'Plugin fixes', status: 'done', decidedBy: 'owner' }), at: day('2026-10-17') },
      // Past focus offers Rename and Edit goal on a done area: each owner row repeats the whole area, still done.
      { fields: area('fa_fixes', { name: 'Small plugin fixes', status: 'done', decidedBy: 'owner' }), at: day('2026-10-20') },
      { fields: area('fa_fixes', { name: 'Small plugin fixes', goal: 'Fixes people asked for twice.', status: 'done', decidedBy: 'owner' }), at: day('2026-10-22') },
    ]);
    expect(areaById(result, 'fa_fixes')).toMatchObject({ name: 'Small plugin fixes', status: 'done', doneAt: '2026-10-17T12:00:00.000Z', savedAt: '2026-10-22T12:00:00.000Z' });
  });

  it('clears the done date when the area goes back in focus, and dates it anew when it is marked done again', () => {
    const day = (date: string) => Date.parse(`${date}T12:00:00Z`);
    const rows = [
      { fields: area('fa_fixes', { status: 'done', decidedBy: 'owner' }), at: day('2026-10-17') },
      { fields: area('fa_fixes', { status: 'kept', decidedBy: 'owner' }), at: day('2026-10-18') },
    ];
    expect(areaById(focus(rows), 'fa_fixes')).toMatchObject({ status: 'kept', doneAt: null });
    const again = focus([...rows, { fields: area('fa_fixes', { status: 'done', decidedBy: 'owner' }), at: day('2026-10-25') }]);
    expect(areaById(again, 'fa_fixes')).toMatchObject({ status: 'done', doneAt: '2026-10-25T12:00:00.000Z' });
  });

  // Phase 6 fix AP-L7: one definition of the done date, which My Work's sample (standing in for the worker) takes too.
  it('dates a done area by one rule, the one My Work\'s sample takes', () => {
    const at = '2026-10-25T12:00:00.000Z';
    expect(doneAtAfterChange({ statusBefore: 'kept', doneAtBefore: null, statusAfter: 'done', changedAt: at })).toBe(at);
    expect(doneAtAfterChange({ statusBefore: undefined, doneAtBefore: null, statusAfter: 'done', changedAt: at })).toBe(at);
    expect(doneAtAfterChange({ statusBefore: 'done', doneAtBefore: '2026-10-17T12:00:00.000Z', statusAfter: 'done', changedAt: at })).toBe('2026-10-17T12:00:00.000Z');
    expect(doneAtAfterChange({ statusBefore: 'done', doneAtBefore: '2026-10-17T12:00:00.000Z', statusAfter: 'kept', changedAt: at })).toBeNull();
    // The sample applies its changes with this rule instead of a copy of it.
    const sample = readFileSync(resolve(import.meta.dir, '../../src/ui/my-work/src/live/sample-source.ts'), 'utf8');
    expect({ imports: /import \{ doneAtAfterChange \} from '[^']*focus-done-date\.mjs'/.test(sample), calls: sample.includes('doneAt: doneAtAfterChange(') }).toEqual({ imports: true, calls: true });
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
    for (const [name, label] of [['My Work', 'my work'], ['Ship the My Work viewer', 'my work'], ['other', 'other'], ['Past focus notes', 'past focus'], ['Focus areas', 'focus areas'], ['Review-Stack cleanup', 'review stack'], ['  SUGGESTED ', 'suggested']]) {
      expect(navWordIn(name)).toBe(label);
    }
    // The rail's old group labels are gone, and the bar's single common words never refuse a name.
    for (const name of ['Work viewer', 'Network', 'My laptop', 'Focus mode', 'Others', 'Monitor', 'Steer', 'Rules engine', 'Requests', 'Memory', 'Workspace', 'Focus area', 'Review']) expect(navWordIn(name)).toBeNull();
  });

  it('refuses a proposed area named like a nav item', () => {
    const proposal = { kind: 'new', name: 'Suggested fixes', goal: 'g', about: 'a', evidence: 'e', sameAs: null, requests: [] };
    expect(() => routerFocusRows({ placements: [], proposals: [proposal] }, [], () => 'fa_new')).toThrow(/proposals\[0\] is named "Suggested fixes", which reuses the nav word "suggested"/);
    expect(routerFocusRows({ placements: [], proposals: [{ ...proposal, name: 'Fixes' }] }, [], () => 'fa_new').focusAreaIds).toEqual(['fa_new']);
  });
});

describe('sub focuses', () => {
  const OTHER_ANCHOR = JSON.stringify(['conversation', 'claude', 'session-2']);
  const subFocus = (subFocusId: string, focusAreaId: string, change: Record<string, unknown> = {}) => subFocusRowFields({
    subFocusId, focusAreaId, name: subFocusId.toUpperCase(), decidedBy: 'system', mergedInto: null, ...change,
  } as any);
  const inSubFocus = (subFocusId: string | null, focusAreaId: string, placedBy: 'router' | 'owner', anchorConversationKey = ANCHOR) =>
    subFocusPlacementRowFields({ anchorConversationKey, subFocusId, focusAreaId, placedBy });
  const viewer = [
    { fields: area('fa_viewer', { status: 'kept', decidedBy: 'owner' }), at: 1000 },
    { fields: placement('fa_viewer', 'router'), at: 1000 },
    { fields: placement('fa_viewer', 'router', OTHER_ANCHOR), at: 1000 },
  ];

  it('reduces sub focus rows onto their area and each request\'s placement, which placeRequests serves', () => {
    const result = focus([
      ...viewer,
      { fields: subFocus('sf_layout', 'fa_viewer', { name: 'Layout and navigation' }), at: 2000 },
      { fields: subFocus('sf_speed', 'fa_viewer', { name: 'Speed' }), at: 2000 },
      { fields: inSubFocus('sf_layout', 'fa_viewer', 'router'), at: 3000 },
      // Ungrouped: a decision too, so the request is not grouped and has no sub focus.
      { fields: inSubFocus(null, 'fa_viewer', 'router', OTHER_ANCHOR), at: 3000 },
    ]);
    expect(areaById(result, 'fa_viewer')!.subFocuses).toEqual([
      { subFocusId: 'sf_layout', name: 'Layout and navigation', decidedBy: 'system' },
      { subFocusId: 'sf_speed', name: 'Speed', decidedBy: 'system' },
    ]);
    expect([...result.subFocusIdByAnchor]).toEqual([[ANCHOR, 'sf_layout']]);
    expect(result.subFocusPlacementFor(OTHER_ANCHOR, 'fa_viewer')).toEqual({ placedBy: 'router', subFocusId: null });
    const ledger = { groups: { groups: {} } };
    const placed = placeRequests([{ id: ANCHOR, groupId: null, conversationKey: ANCHOR }, { id: OTHER_ANCHOR, groupId: null, conversationKey: OTHER_ANCHOR }],
      result.focusAreaIdByAnchor, ledger, result.subFocusIdByAnchor);
    expect(placed.map((request) => [request.focusAreaId, request.subFocusId])).toEqual([['fa_viewer', 'sf_layout'], ['fa_viewer', undefined]]);
    expect('subFocusId' in placed[1]).toBe(false);
  });

  it('lets the owner\'s placement beat the router\'s, whatever the order, and never lets a refresh rename the owner\'s sub focus', () => {
    const result = focus([
      ...viewer,
      { fields: subFocus('sf_a', 'fa_viewer'), at: 2000 },
      { fields: subFocus('sf_b', 'fa_viewer'), at: 2000 },
      { fields: inSubFocus('sf_a', 'fa_viewer', 'router'), at: 3000 },
      { fields: inSubFocus('sf_b', 'fa_viewer', 'owner'), at: 4000 },
      { fields: inSubFocus('sf_a', 'fa_viewer', 'router'), at: 5000 },
      { fields: subFocus('sf_b', 'fa_viewer', { name: 'Named by you', decidedBy: 'owner' }), at: 6000 },
      { fields: subFocus('sf_b', 'fa_viewer', { name: 'Renamed by a refresh' }), at: 7000 },
    ]);
    expect(result.subFocusIdByAnchor.get(ANCHOR)).toBe('sf_b');
    expect(result.subFocusPlacementFor(ANCHOR, 'fa_viewer')).toEqual({ placedBy: 'owner', subFocusId: 'sf_b' });
    expect(areaById(result, 'fa_viewer')!.subFocuses.find((entry) => entry.subFocusId === 'sf_b')).toEqual({ subFocusId: 'sf_b', name: 'Named by you', decidedBy: 'owner' });
    // The owner taking it out of every sub focus also beats a later router placement.
    const ungrouped = focus([...viewer, { fields: subFocus('sf_a', 'fa_viewer'), at: 2000 },
      { fields: inSubFocus(null, 'fa_viewer', 'owner'), at: 3000 }, { fields: inSubFocus('sf_a', 'fa_viewer', 'router'), at: 4000 }]);
    expect(ungrouped.subFocusIdByAnchor.has(ANCHOR)).toBe(false);
    expect(ungrouped.subFocusPlacementFor(ANCHOR, 'fa_viewer')).toEqual({ placedBy: 'owner', subFocusId: null });
  });

  it('forwards a merged sub focus to the one it was merged into, and leaves a loop or an unreceived target ungrouped', () => {
    const merged = focus([
      ...viewer,
      { fields: subFocus('sf_a', 'fa_viewer'), at: 2000 },
      { fields: subFocus('sf_b', 'fa_viewer'), at: 2000 },
      { fields: subFocus('sf_c', 'fa_viewer'), at: 2000 },
      { fields: inSubFocus('sf_a', 'fa_viewer', 'router'), at: 3000 },
      { fields: subFocus('sf_a', 'fa_viewer', { mergedInto: 'sf_b', decidedBy: 'owner' }), at: 4000 },
      { fields: subFocus('sf_b', 'fa_viewer', { mergedInto: 'sf_c', decidedBy: 'owner' }), at: 5000 },
    ]);
    expect(merged.subFocusIdByAnchor.get(ANCHOR)).toBe('sf_c');
    // A merged sub focus is no longer one of the area's.
    expect(areaById(merged, 'fa_viewer')!.subFocuses.map((entry) => entry.subFocusId)).toEqual(['sf_c']);
    const loop = focus([
      ...viewer,
      { fields: subFocus('sf_a', 'fa_viewer'), at: 2000 },
      { fields: subFocus('sf_b', 'fa_viewer'), at: 2000 },
      { fields: inSubFocus('sf_a', 'fa_viewer', 'router'), at: 3000 },
      { fields: subFocus('sf_a', 'fa_viewer', { mergedInto: 'sf_b', decidedBy: 'owner' }), at: 4000, device: 'laptop' },
      { fields: subFocus('sf_b', 'fa_viewer', { mergedInto: 'sf_a', decidedBy: 'owner' }), at: 4000, device: 'desktop' },
    ]);
    expect(loop.subFocusIdByAnchor.has(ANCHOR)).toBe(false);
    const unreceived = focus([...viewer, { fields: subFocus('sf_a', 'fa_viewer', { mergedInto: 'sf_unseen', decidedBy: 'owner' }), at: 2000 },
      { fields: inSubFocus('sf_a', 'fa_viewer', 'router'), at: 3000 }]);
    expect(unreceived.subFocusIdByAnchor.has(ANCHOR)).toBe(false);
  });

  it('ignores a placement made in another area than the request\'s current one, or into another area\'s sub focus', () => {
    const rows = [
      ...viewer,
      { fields: area('fa_releases', { status: 'kept', decidedBy: 'owner' }), at: 1000 },
      { fields: subFocus('sf_viewer', 'fa_viewer'), at: 2000 },
      { fields: subFocus('sf_releases', 'fa_releases'), at: 2000 },
      { fields: inSubFocus('sf_viewer', 'fa_viewer', 'owner'), at: 3000 },
    ];
    expect(focus(rows).subFocusIdByAnchor.get(ANCHOR)).toBe('sf_viewer');
    // The owner moves the request to Releases: its Viewer sub focus no longer holds, and it is not grouped there yet.
    const moved = focus([...rows, { fields: placement('fa_releases', 'owner'), at: 4000 }]);
    expect(moved.focusAreaIdByAnchor.get(ANCHOR)).toBe('fa_releases');
    expect(moved.subFocusIdByAnchor.has(ANCHOR)).toBe(false);
    expect(moved.subFocusPlacementFor(ANCHOR, 'fa_releases')).toBeNull();
    // A placement that names another area's sub focus never holds, even when the router writes it later.
    const crossed = focus([...rows, { fields: placement('fa_releases', 'owner'), at: 4000 }, { fields: inSubFocus('sf_viewer', 'fa_releases', 'router'), at: 5000 }]);
    expect(crossed.subFocusIdByAnchor.has(ANCHOR)).toBe(false);
    // Moved back to Viewer, the owner's Viewer decision holds again.
    expect(focus([...rows, { fields: placement('fa_releases', 'owner'), at: 4000 }, { fields: placement('fa_viewer', 'owner'), at: 5000 }]).subFocusIdByAnchor.get(ANCHOR)).toBe('sf_viewer');
  });

  it('an owner-renamed sub focus survives an area merge: the merged area\'s sub focuses and placements show under the area it was merged into, and go back when the merge is undone', () => {
    const rows: Row[] = [
      ...viewer,
      { fields: area('fa_releases', { status: 'kept', decidedBy: 'owner' }), at: 1000 },
      { fields: subFocus('sf_layout', 'fa_viewer'), at: 2000 },
      { fields: subFocus('sf_notes', 'fa_releases', { name: 'Release notes' }), at: 2000 },
      { fields: inSubFocus('sf_layout', 'fa_viewer', 'router'), at: 3000 },
      { fields: inSubFocus('sf_layout', 'fa_viewer', 'owner', OTHER_ANCHOR), at: 3000 },
      { fields: subFocus('sf_layout', 'fa_viewer', { name: 'Named by you', decidedBy: 'owner' }), at: 4000 },
    ];
    const mergedViewer = { fields: area('fa_viewer', { status: 'kept', mergedInto: 'fa_releases', decidedBy: 'owner' }), at: 5000 };
    const merged = focus([...rows, mergedViewer]);
    expect([ANCHOR, OTHER_ANCHOR].map((anchor) => merged.focusAreaIdByAnchor.get(anchor))).toEqual(['fa_releases', 'fa_releases']);
    // Listed once, under the area its requests now sit in, with the owner's name; the merged-away area lists none.
    expect(areaById(merged, 'fa_releases')!.subFocuses).toEqual([
      { subFocusId: 'sf_layout', name: 'Named by you', decidedBy: 'owner' },
      { subFocusId: 'sf_notes', name: 'Release notes', decidedBy: 'system' },
    ]);
    expect(areaById(merged, 'fa_viewer')!.subFocuses).toEqual([]);
    expect([ANCHOR, OTHER_ANCHOR].map((anchor) => merged.subFocusIdByAnchor.get(anchor))).toEqual(['sf_layout', 'sf_layout']);
    expect(merged.subFocusPlacementFor(OTHER_ANCHOR, 'fa_releases')).toEqual({ placedBy: 'owner', subFocusId: 'sf_layout' });
    // A later system row (a refresh) still never renames it.
    expect(areaById(focus([...rows, mergedViewer, { fields: subFocus('sf_layout', 'fa_viewer', { name: 'Renamed by a refresh' }), at: 6000 }]), 'fa_releases')!.subFocuses[0].name).toBe('Named by you');
    // The owner renames it again while it shows under Releases, which names Releases on the row; then undoes the merge.
    // It stays in Viewer with its requests: a sub focus never moves to another area.
    const renamedWhileMerged = { fields: subFocus('sf_layout', 'fa_releases', { name: 'Layout', decidedBy: 'owner' }), at: 6000 };
    const restored = focus([...rows, mergedViewer, renamedWhileMerged, { fields: area('fa_viewer', { status: 'suggested', decidedBy: 'owner-restore' }), at: 7000 }]);
    expect(areaById(restored, 'fa_viewer')!.subFocuses).toEqual([{ subFocusId: 'sf_layout', name: 'Layout', decidedBy: 'owner' }]);
    expect(areaById(restored, 'fa_releases')!.subFocuses.map((entry) => entry.subFocusId)).toEqual(['sf_notes']);
    expect([ANCHOR, OTHER_ANCHOR].map((anchor) => restored.subFocusIdByAnchor.get(anchor))).toEqual(['sf_layout', 'sf_layout']);
    // A merge into an area that is gone (dismissed) leaves the sub focus listed nowhere and its requests not sorted.
    const gone = focus([...rows, mergedViewer, { fields: area('fa_releases', { status: 'dismissed', decidedBy: 'owner' }), at: 6000 }]);
    expect(gone.focusAreas.flatMap((entry) => entry.subFocuses)).toEqual([]);
    expect(gone.subFocusIdByAnchor.size).toBe(0);
  });

  it('reads each area\'s sub focus pass record from this computer only, beside the Other pass record', () => {
    const rows: Row[] = [
      ...viewer,
      { fields: { other_pass_hash: 'aaaaaaaaaaaaaaaa' }, at: 2000, device: 'this-device' },
      { fields: { sub_focus_area_id: 'fa_viewer', sub_focus_pass_hash: 'bbbbbbbbbbbbbbbb' }, at: 3000, device: 'this-device' },
      { fields: { sub_focus_area_id: 'fa_viewer', sub_focus_pass_hash: 'cccccccccccccccc' }, at: 4000, device: 'another-computer' },
    ];
    const result = focus(rows, { localDeviceId: 'this-device' });
    expect(result.otherPassHash).toBe('aaaaaaaaaaaaaaaa');
    expect([...result.subFocusPassHashes]).toEqual([['fa_viewer', 'bbbbbbbbbbbbbbbb']]);
    expect([...focus(rows).subFocusPassHashes]).toEqual([]);
  });

  it('reads a failed sub focus pass apart from an answered one, from this computer only, and an answered pass clears it', () => {
    const failed: Row[] = [
      ...viewer,
      { fields: { sub_focus_area_id: 'fa_viewer', sub_focus_pass_hash: 'bbbbbbbbbbbbbbbb' }, at: 2000, device: 'this-device' },
      { fields: { sub_focus_area_id: 'fa_viewer', sub_focus_failed_hash: 'cccccccccccccccc' }, at: 3000, device: 'this-device' },
      { fields: { sub_focus_area_id: 'fa_viewer', sub_focus_failed_hash: 'dddddddddddddddd' }, at: 4000, device: 'another-computer' },
    ];
    const result = focus(failed, { localDeviceId: 'this-device' });
    // The failure is not an answer: the last answered pass still names the set it looked at.
    expect([...result.subFocusPassHashes]).toEqual([['fa_viewer', 'bbbbbbbbbbbbbbbb']]);
    expect([...result.subFocusFailedHashes]).toEqual([['fa_viewer', 'cccccccccccccccc']]);
    expect([...focus(failed).subFocusFailedHashes]).toEqual([]);
    const answered = focus([...failed, { fields: { sub_focus_area_id: 'fa_viewer', sub_focus_pass_hash: 'cccccccccccccccc', sub_focus_failed_hash: null }, at: 5000, device: 'this-device' }], { localDeviceId: 'this-device' });
    expect([...answered.subFocusPassHashes]).toEqual([['fa_viewer', 'cccccccccccccccc']]);
    expect([...answered.subFocusFailedHashes]).toEqual([['fa_viewer', null]]);
  });

  it('a reducer run on rows it does not know still returns the same areas and placements', () => {
    const known = focus(viewer);
    const withUnknown = focus([
      ...viewer,
      { fields: { task: 'Sub sub focus: sf_x', focus_area_id: 'fa_viewer', name: 'From a later build' }, at: 2000 },
      { fields: { task: 'Future row: x', anchor_conversation_key: ANCHOR, focus_area_id: 'fa_endless' }, at: 2000 },
      { fields: { some_later_pass: 'dddddddddddddddd' }, at: 2000, device: 'this-device' },
    ], { localDeviceId: 'this-device' });
    expect(withUnknown.focusAreas).toEqual(known.focusAreas);
    expect([...withUnknown.focusAreaIdByAnchor]).toEqual([...known.focusAreaIdByAnchor]);
    expect(withUnknown.otherPassHash).toBeNull();
  });

  it('throws on a sub focus row it cannot read, and refuses rows that cannot be saved', () => {
    expect(() => focus([...viewer, { fields: { ...subFocus('sf_a', 'fa_viewer'), decided_by: 'someone' }, at: 2000 }])).toThrow('unknown writer');
    expect(() => focus([...viewer, { fields: { ...subFocus('sf_a', 'fa_viewer'), name: null }, at: 2000 }])).toThrow('has no name');
    expect(() => focus([...viewer, { fields: { ...inSubFocus('sf_a', 'fa_viewer', 'router'), placed_by: 'guess' }, at: 2000 }])).toThrow('unknown writer');
    expect(() => subFocus('sf_a', 'other')).toThrow();
    expect(() => subFocus('sf_a', 'fa_viewer', { decidedBy: 'owner-restore' })).toThrow();
    expect(() => subFocus('sf_a', 'fa_viewer', { name: 'x'.repeat(2000) })).toThrow(RangeError);
    expect(() => inSubFocus('sf_a', 'other', 'owner')).toThrow();
    expect(() => inSubFocus('', 'fa_viewer', 'owner')).toThrow();
  });

  it('routerFocusRows writes a sub focus answer as the system, and refuses a group of one, an unknown sub focus or a request placed twice', () => {
    const saved = focus([...viewer, { fields: subFocus('sf_layout', 'fa_viewer'), at: 2000 }]).focusAreas;
    const body = { placements: [], proposals: [], subFocus: {
      focusAreaId: 'fa_viewer', passHash: '0123456789abcdef',
      newSubFocuses: [{ name: 'Speed', anchorConversationKeys: [ANCHOR, OTHER_ANCHOR] }],
      placements: [{ anchorConversationKey: 'third', subFocusId: 'sf_layout' }, { anchorConversationKey: 'fourth', subFocusId: null }],
    } };
    const planned = routerFocusRows(body, saved, () => 'fa_unused', () => 'sf_new');
    expect(planned.rows.map((row) => [row.task, row.sub_focus_id, row.decided_by ?? row.placed_by ?? null])).toEqual([
      ['Sub focus: sf_new', 'sf_new', 'system'],
      [`Sub focus placement: ${ANCHOR}`, 'sf_new', 'router'],
      [`Sub focus placement: ${OTHER_ANCHOR}`, 'sf_new', 'router'],
      ['Sub focus placement: third', 'sf_layout', 'router'],
      ['Sub focus placement: fourth', null, 'router'],
      [undefined, undefined, null],
    ]);
    // An answered pass clears a failed one on the same area.
    expect(planned.rows.at(-1)).toEqual({ sub_focus_area_id: 'fa_viewer', sub_focus_pass_hash: '0123456789abcdef', sub_focus_failed_hash: null });
    // A failed pass writes only its record, never an answered pass.
    const failedPass = { focusAreaId: 'fa_viewer', newSubFocuses: [], placements: [], passHash: null, failedPassHash: 'fedcba9876543210' };
    expect(routerFocusRows({ placements: [], proposals: [], subFocus: failedPass }, saved).rows).toEqual([{ sub_focus_area_id: 'fa_viewer', sub_focus_failed_hash: 'fedcba9876543210' }]);
    expect(() => routerFocusRows({ placements: [], proposals: [], subFocus: { ...failedPass, passHash: '0123456789abcdef' } }, saved)).toThrow(/answered or as failed, not both/);
    const refused = (subFocusChange: Record<string, unknown>, areas = saved) => () => routerFocusRows({ ...body, subFocus: { ...body.subFocus, ...subFocusChange } } as any, areas, undefined, () => 'sf_new');
    expect(refused({ newSubFocuses: [{ name: 'Alone', anchorConversationKeys: [ANCHOR] }] })).toThrow(/holds 1 request; a sub focus groups 2 or more/);
    expect(refused({ placements: [{ anchorConversationKey: 'third', subFocusId: 'sf_gone' }] })).toThrow(/sf_gone, which is not a sub focus of fa_viewer/);
    expect(refused({ placements: [{ anchorConversationKey: ANCHOR, subFocusId: null }] })).toThrow(/a second time/);
    expect(refused({ focusAreaId: 'fa_missing' })).toThrow(/not a kept focus area/);
    expect(refused({}, focus([{ fields: area('fa_viewer'), at: 1000 }]).focusAreas)).toThrow(/not a kept focus area/);
  });
});
