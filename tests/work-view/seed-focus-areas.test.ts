import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../helpers/scratch-dir';
import { buildSeed, loadClassification, mapRoutedToAnchors, placementEvidence, UNSURE_P } from '../../scripts/seed-focus-areas.mjs';
import { focusAreaRowFields, isOwnerDismissedArea, isWithdrawnArea, MY_FOCUS_LIST, ownerGoalsAreaRows, placementRowFields, readFocus, routerFocusRows, seedFocusRows, seedUndoRows } from '../../src/services/work-view/my-focus.mjs';
import { focusBasis, groupIdFor } from '../../src/services/work-view/request-groups.mjs';

const key = (id: string) => JSON.stringify(['conversation', 'codex', id]);
const tests = { rule: 'no', request: 'no', area: 'yes' };
const LINES = [
  { id: 'viewer', ask: 'Ship the My Work viewer', about: 'the live viewer' },
  { id: 'sweeps', ask: 'Community sweeps', about: 'contributor PRs' },
  { id: 'signals', ask: 'Replace signals.cmem.ai', about: 'the site' },
  { id: 'publish', ask: 'Never make me publish by hand', about: 'how releases are done' },
];
const CLASSIFICATION = {
  lines: {
    viewer: { kind: 'area', name: 'Viewer', goal: 'A live view of the work.', tests },
    sweeps: { kind: 'area', name: 'Community', goal: 'Contributors are reviewed.', tests },
    signals: { kind: 'ask', placeIn: 'other', tests },
    publish: { kind: 'rule', tests },
  },
};
const group = (anchor: string) => [groupIdFor(anchor), { anchor, title: anchor }] as const;

describe('seed classification', () => {
  it('loads areas in line order, asks with their area, and rules', () => {
    const loaded = loadClassification(LINES, CLASSIFICATION);
    expect(loaded.areas.map((area: any) => [area.key, area.name, area.priorityRank])).toEqual([['viewer', 'Viewer', 1], ['sweeps', 'Community', 2]]);
    expect(loaded.areas[0].about).toBe('the live viewer');
    expect(loaded.asks).toEqual([{ line: 'signals', ask: 'Replace signals.cmem.ai', placeIn: 'other' }]);
    expect(loaded.rules.map((rule: any) => rule.line)).toEqual(['publish']);
    expect(loaded.areaKeyForLine('viewer')).toBe('viewer');
    expect(loaded.areaKeyForLine('signals')).toBe('other');
    expect(loaded.areaKeyForLine(null)).toBe('other');
    expect(() => loaded.areaKeyForLine('publish')).toThrow(/classified a rule/);
    expect(() => loaded.areaKeyForLine('nope')).toThrow(/not a line/);
  });

  it('refuses a missing, extra, untested or misfiled line', () => {
    const { signals, ...withoutSignals } = CLASSIFICATION.lines;
    expect(() => loadClassification(LINES, { lines: withoutSignals })).toThrow(/missing signals/);
    expect(() => loadClassification(LINES, { lines: { ...CLASSIFICATION.lines, ghost: { kind: 'area', name: 'G', goal: 'g', tests } } })).toThrow(/not in lines.json: ghost/);
    expect(() => loadClassification(LINES, { lines: { ...CLASSIFICATION.lines, viewer: { kind: 'area', name: 'Viewer', goal: 'g' } } })).toThrow(/three tests/);
    expect(() => loadClassification(LINES, { lines: { ...CLASSIFICATION.lines, signals: { kind: 'ask', placeIn: 'publish', tests } } })).toThrow(/placeIn must be an area line/);
  });

  it('flags a placement unsure only below the cutoff', () => {
    expect(UNSURE_P).toBe(0.6);
    expect(placementEvidence({ line: 'viewer', p: 0.59 }, 'viewer')).toMatch(/p=0\.59\)\. Unsure: p < 0\.6\./);
    expect(placementEvidence({ line: 'viewer', p: 0.6 }, 'viewer')).not.toMatch(/Unsure/);
    expect(placementEvidence({ line: null, p: 0.4 }, 'other')).toMatch(/no line fits \(p=0\.4 for none\)\. Unsure/);
    expect(placementEvidence({ line: 'signals', p: 0.9 }, 'other')).toMatch(/an ask filed in other/);
  });
});

describe('mapping routed requests to anchors', () => {
  const [viewerId, viewer] = group(key('a'));
  const [sweepId, sweep] = group(key('b'));
  const [smallSweepId, smallSweep] = group(key('c'));
  const treeLedger = { groups: { [viewerId]: viewer, [sweepId]: sweep, [smallSweepId]: smallSweep } };

  it('places current anchors and reports a request absorbed into another routed one', () => {
    const currentLedger = { groups: { [viewerId]: viewer, [sweepId]: sweep }, conversations: { [key('a')]: viewerId, [key('b')]: sweepId, [key('c')]: sweepId } };
    const routed = [{ id: viewerId, line: 'viewer', p: 0.9 }, { id: sweepId, line: 'sweeps', p: 0.5 }, { id: smallSweepId, line: 'sweeps', p: 0.8 }];
    const mapped = mapRoutedToAnchors(routed, treeLedger, currentLedger);
    expect(mapped.mapped.map((item: any) => item.anchorConversationKey)).toEqual([key('a'), key('b')]);
    expect(mapped.absorbed).toEqual([{ id: smallSweepId, holder: sweepId, anchorConversationKey: key('c') }]);
    const seed = buildSeed({ lines: LINES, classification: CLASSIFICATION, tree: { routed }, treeLedger, currentLedger });
    expect(seed.placements.map((placement: any) => [placement.area, placement.unsure])).toEqual([['viewer', false], ['sweeps', true]]);
    expect(seed.body.placements[1].evidence).toMatch(/^Seed: .*Unsure/);
    // Each placement carries its request's focus basis, which moves when the request changes, so the focus step re-checks it.
    expect(seed.body.placements[1].basis).toBe(focusBasis({ groups: currentLedger }, sweepId));
    const grown = { ...currentLedger, conversations: { ...currentLedger.conversations, [key('new')]: sweepId } };
    expect(focusBasis({ groups: grown }, sweepId)).not.toBe(seed.body.placements[1].basis);
  });

  it('fails loudly on every unmapped request instead of dropping it', () => {
    const currentLedger = { groups: { [viewerId]: viewer }, conversations: { [key('a')]: viewerId } };
    const routed = [{ id: viewerId, line: 'viewer', p: 0.9 }, { id: sweepId, line: 'sweeps', p: 0.9 }, { id: 'g_000000000000', line: null, p: 0.9 }];
    expect(() => mapRoutedToAnchors(routed, treeLedger, currentLedger))
      .toThrow(new RegExp(`2 routed request\\(s\\) map to no current request: ${sweepId} \\(its conversation is in no current request\\); g_000000000000 \\(not a group in the tree ledger\\)`));
    // A conversation held by a request Jev did not route is unmapped too.
    const held = { groups: { [viewerId]: viewer, g_other: { anchor: key('z') } }, conversations: { [key('a')]: viewerId, [key('b')]: 'g_other' } };
    expect(() => mapRoutedToAnchors([{ id: sweepId, line: 'sweeps', p: 0.9 }], treeLedger, held)).toThrow(/held by g_other, which Jev did not route/);
  });
});

describe('seed rows and undo rows', () => {
  let directory: string;
  let database: Database;
  let at: number;
  const insert = (fields: Record<string, unknown>) => database.prepare('INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?)')
    .run('home', MY_FOCUS_LIST, JSON.stringify(fields), at++);
  const focus = () => readFocus(database, { localDeviceId: '' });
  const seedBody = {
    areas: [
      { key: 'viewer', name: 'Viewer', goal: 'g', about: 'a', priorityRank: 1, evidence: 'Seed: viewer' },
      { key: 'sweeps', name: 'Community', goal: 'g', about: 'a', priorityRank: 2, evidence: 'Seed: sweeps' },
      { key: 'endless', name: 'Endless Mode', goal: 'g', about: 'a', priorityRank: 3, evidence: 'Seed: endless' },
    ],
    placements: [
      { anchorConversationKey: key('a'), area: 'viewer', confidence: 0.9, basis: 'aaaaaaaaaaaaaaaa', evidence: 'Seed: viewer' },
      { anchorConversationKey: key('b'), area: 'sweeps', confidence: 0.5, basis: 'bbbbbbbbbbbbbbbb', evidence: 'Seed: sweeps. Unsure: p < 0.6.' },
      { anchorConversationKey: key('c'), area: 'other', confidence: 0.7, basis: 'cccccccccccccccc', evidence: 'Seed: none' },
      { anchorConversationKey: key('d'), area: 'viewer', confidence: 0.9, basis: 'dddddddddddddddd', evidence: 'Seed: viewer' },
    ],
  };
  let ids: number;
  const newId = () => `fa_seed${++ids}`;

  beforeEach(() => {
    directory = scratchDir('seed-focus');
    database = new Database(join(directory, 'focus.db'));
    database.exec(`CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER,
      origin_device_id TEXT, origin_local_id TEXT)`);
    at = 1000;
    ids = 0;
  });
  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('writes suggested seed areas and router placements, never over an existing placement', () => {
    insert(placementRowFields({ anchorConversationKey: key('d'), focusAreaId: 'other', placedBy: 'owner' }));
    const plan = seedFocusRows(seedBody, focus(), newId);
    for (const fields of plan.rows) insert(fields);
    const after = focus();
    expect(after.focusAreas.map((area: any) => [area.name, area.status, area.source, area.decidedBy])).toEqual([
      ['Viewer', 'suggested', 'seed', 'system'], ['Community', 'suggested', 'seed', 'system'], ['Endless Mode', 'suggested', 'seed', 'system']]);
    expect(plan.skipped).toEqual([{ anchorConversationKey: key('d'), placedBy: 'owner', focusAreaId: 'other' }]);
    expect(Object.fromEntries(after.focusAreaIdByAnchor)).toEqual({ [key('a')]: 'fa_seed1', [key('b')]: 'fa_seed2', [key('c')]: 'other', [key('d')]: 'other' });
    expect(after.placementsByAnchor.get(key('a'))?.router).toMatchObject({ focusAreaId: 'fa_seed1', basis: 'aaaaaaaaaaaaaaaa', evidence: 'Seed: viewer' });
    // Seeding twice is refused while a seed area is live.
    expect(() => seedFocusRows(seedBody, after, newId)).toThrow(/already applied/);
  });

  it('refuses a nav word in an area name, and needs an explicit match once areas are saved', () => {
    expect(() => seedFocusRows({ ...seedBody, areas: [{ ...seedBody.areas[0], name: 'My Work' }] }, focus(), newId)).toThrow(/reuses the nav word "my work"/);
    expect(() => seedFocusRows({ ...seedBody, areas: [{ ...seedBody.areas[0], name: 'Other things' }] }, focus(), newId)).toThrow(/nav word "other"/);
    insert(focusAreaRowFields({ focusAreaId: 'fa_mined', name: 'Viewer UI', goal: 'g', status: 'suggested', priorityRank: 1, ownerRank: null, source: 'owner-goals', mergedInto: null, evidence: 'e', decidedBy: 'system' }));
    expect(() => seedFocusRows(seedBody, focus(), newId)).toThrow(/must state "matches"/);
    const areas = [{ ...seedBody.areas[0], matches: 'fa_mined' }, { ...seedBody.areas[1], matches: null }];
    const plan = seedFocusRows({ ...seedBody, areas, placements: [] }, focus(), newId);
    expect(plan.focusAreaIds).toEqual({ viewer: 'fa_mined', sweeps: 'fa_seed1' });
    expect(plan.created).toEqual(['fa_seed1']);
    // Seed placements need the seed evidence marker and a basis.
    expect(() => seedFocusRows({ areas, placements: [{ ...seedBody.placements[0], evidence: 'viewer' }] }, focus(), newId)).toThrow(/must start with "Seed: "/);
    expect(() => seedFocusRows({ areas, placements: [{ ...seedBody.placements[0], basis: '' }] }, focus(), newId)).toThrow(/focus basis/);
  });

  it('undo withdraws only areas the owner neither decided nor uses, and never empties an owner area', () => {
    const plan = seedFocusRows({ ...seedBody, areas: seedBody.areas.slice(0, 3) }, focus(), newId);
    for (const fields of plan.rows) insert(fields);
    const rowsAfterSeed = (database.prepare('SELECT count(*) AS n FROM work_state_entries').get() as { n: number }).n;
    // The owner keeps Community; moves request e (not seeded) into Endless Mode; moves request a into Community.
    // A later focus step re-places request c with a new basis.
    const community = focus().focusAreas.find((area: any) => area.focusAreaId === 'fa_seed2');
    insert(focusAreaRowFields({ ...community, status: 'kept', decidedBy: 'owner' }));
    insert(placementRowFields({ anchorConversationKey: key('e'), focusAreaId: 'fa_seed3', placedBy: 'owner' }));
    insert(placementRowFields({ anchorConversationKey: key('a'), focusAreaId: 'fa_seed2', placedBy: 'owner' }));
    insert(placementRowFields({ anchorConversationKey: key('c'), focusAreaId: 'other', placedBy: 'router', basis: '0123456789abcdef', evidence: 'Fits no area.' }));

    const undo = seedUndoRows({ focusAreaIds: plan.created, placements: plan.placed }, focus());
    expect(undo.withdrawn).toEqual(['fa_seed1']);
    expect(undo.leftByOwner).toEqual(['fa_seed2']);
    expect(undo.leftInOwnerUse).toEqual(['fa_seed3']);
    // a and d sat in the withdrawn Viewer; b sits in Community, which the owner kept; c was replaced.
    expect(undo.cleared).toEqual([key('a'), key('d')]);
    expect(undo.leftInOwnerArea).toEqual([key('b')]);
    expect(undo.replaced).toEqual([key('c')]);
    for (const fields of undo.rows) insert(fields);
    // Append-only: nothing deleted.
    expect((database.prepare('SELECT count(*) AS n FROM work_state_entries').get() as { n: number }).n).toBe(rowsAfterSeed + 4 + undo.rows.length);
    const after = focus();
    const viewer = after.focusAreas.find((area: any) => area.focusAreaId === 'fa_seed1');
    expect([viewer.status, viewer.decidedBy]).toEqual(['dismissed', 'system']);
    // A system withdrawal is not an owner dismissal: the focus step may propose it again.
    expect(isOwnerDismissedArea(viewer)).toBe(false);
    expect(isWithdrawnArea(viewer)).toBe(true);
    expect(after.focusAreas.find((area: any) => area.focusAreaId === 'fa_seed2')?.status).toBe('kept');
    expect(after.focusAreas.find((area: any) => area.focusAreaId === 'fa_seed3')?.status).toBe('suggested');
    // The owner's moves stand, the kept area keeps its request, d is back to not sorted.
    expect(after.focusAreaIdByAnchor.get(key('a'))).toBe('fa_seed2');
    expect(after.focusAreaIdByAnchor.get(key('e'))).toBe('fa_seed3');
    expect(after.focusAreaIdByAnchor.get(key('b'))).toBe('fa_seed2');
    expect(after.focusAreaIdByAnchor.has(key('d'))).toBe(false);
    expect(after.focusAreaIdByAnchor.get(key('c'))).toBe('other');
    // A second undo writes nothing new for areas, and refuses a note naming a non-seed or unknown area.
    expect(seedUndoRows({ focusAreaIds: plan.created, placements: [] }, after).alreadyWithdrawn).toEqual(['fa_seed1']);
    insert(focusAreaRowFields({ focusAreaId: 'fa_mined', name: 'Mined', goal: 'g', status: 'suggested', priorityRank: 1, ownerRank: null, source: 'owner-goals', mergedInto: null, evidence: 'e', decidedBy: 'system' }));
    expect(() => seedUndoRows({ focusAreaIds: ['fa_mined'], placements: [] }, focus())).toThrow(/did not create/);
    expect(() => seedUndoRows({ focusAreaIds: ['fa_ghost'], placements: [] }, focus())).toThrow(/not a saved focus area/);
    // A withdrawn area is no match target for owner-goals, and a proposal naming it gets an accurate refusal.
    expect(() => ownerGoalsAreaRows([{ name: 'Viewer', goal: 'g', rank: 1, matches: 'fa_seed1', evidence: 'e' }], focus().focusAreas)).toThrow(/not a saved focus area/);
    expect(() => routerFocusRows({ placements: [], proposals: [{ kind: 'new', name: 'Viewer', goal: 'g', about: 'a', evidence: 'e', sameAs: 'fa_seed1', requests: [{ anchorConversationKey: key('z'), basis: '0123456789abcdef' }] }] }, focus().focusAreas))
      .toThrow(/was withdrawn and takes no requests/);
  });

  it('undo leaves a seed area live when the owner merged another area into it', () => {
    const plan = seedFocusRows({ ...seedBody, areas: seedBody.areas.slice(0, 1), placements: [] }, focus(), newId);
    for (const fields of plan.rows) insert(fields);
    insert(focusAreaRowFields({ focusAreaId: 'fa_mined', name: 'Live view', goal: 'g', status: 'suggested', priorityRank: 2, ownerRank: null, source: 'owner-goals', mergedInto: 'fa_seed1', evidence: 'e', decidedBy: 'owner' }));
    const undo = seedUndoRows({ focusAreaIds: plan.created, placements: [] }, focus());
    expect(undo.leftInOwnerUse).toEqual(['fa_seed1']);
    expect(undo.rows).toEqual([]);
  });
});
