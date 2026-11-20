#!/usr/bin/env bun
// One-time seed of My Focus from the Jev grouping research (PLAN.md Phase 5): the owner's 16 lines become suggested
// focus areas (or asks, or rules, as the reviewed classification file says), and the Jev routing of each request
// (tree2.json `routed`) becomes a router placement. Dry run by default.
//
//   bun scripts/seed-focus-areas.mjs --tree-ledger <request-groups.json tree2 was routed from>   dry run
//   bun scripts/seed-focus-areas.mjs --tree-ledger <...> --apply                                 write, then a note
//   bun scripts/seed-focus-areas.mjs --undo <note>                                               take one seed back
//   options: --lines <lines.json> --tree <tree2.json> --classification <seed-classification.json>
//            (default: .scratch/my-focus/ in this repo)
//
// Writes go through the worker (POST /api/work-view/focus/seed), like every other my-focus write: the rows sync, and
// the worker checks them against the saved areas at write time. The data folder is CLAUDE_MEM_DATA_DIR (default
// ~/.claude-mem); the worker is the one that folder's settings name. Every write names the database the script read,
// and a worker serving another one refuses before writing; after a write the script reads the rows back.
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readFocus, seedFocusRows, seedUndoRows, OTHER_FOCUS_AREA_ID, SEED_EVIDENCE_PREFIX } from '../src/services/work-view/my-focus.mjs';
import { focusBasis, groupIdFor } from '../src/services/work-view/request-groups.mjs';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.ts';

/**
 * Placements whose recorded p is under this are flagged "unsure" in their evidence. This is the plan's stated cutoff
 * for flagging (PLAN.md Phase 5), carried over from propose-tree2.mjs, which printed placements under it as "(unsure)".
 * It was never measured: calibration2.json measured "continues a request", not "which line". It only adds a word to
 * the evidence the owner reads; it never decides whether or where a request is placed.
 */
export const UNSURE_P = 0.6;

const KINDS = ['area', 'ask', 'rule'];

/**
 * The reviewed classification of every line: areas (name, goal; rank = order among the areas in lines.json), asks
 * (the area key, or "other", their requests go to) and rules (not written here: rules belong to My Rules). Every
 * line must be classified exactly once; an unknown line, a missing field or an ask pointing at a non-area is refused.
 */
export function loadClassification(lines, classification) {
  const byLine = classification?.lines;
  if (!byLine || typeof byLine !== 'object') throw new TypeError('The classification needs a "lines" object keyed by line id.');
  const ids = lines.map((line) => line.id);
  const extra = Object.keys(byLine).filter((id) => !ids.includes(id));
  if (extra.length) throw new TypeError(`The classification names lines that are not in lines.json: ${extra.join(', ')}.`);
  const missing = ids.filter((id) => !Object.hasOwn(byLine, id));
  if (missing.length) throw new TypeError(`Classify every line; missing ${missing.join(', ')}.`);
  const areas = [], asks = [], rules = [];
  for (const line of lines) {
    const entry = byLine[line.id];
    if (!KINDS.includes(entry.kind)) throw new TypeError(`Line ${line.id}: kind must be one of ${KINDS.join(', ')}.`);
    if (!entry.tests?.rule || !entry.tests?.request || !entry.tests?.area) throw new TypeError(`Line ${line.id}: write the answer to each of the three tests (rule, request, area).`);
    if (entry.kind === 'area') {
      if (!entry.name?.trim() || !entry.goal?.trim()) throw new TypeError(`Line ${line.id}: an area needs a name and a goal.`);
      areas.push({
        key: line.id, name: entry.name.trim(), goal: entry.goal.trim(), about: line.about, priorityRank: areas.length + 1,
        evidence: `Seed: the line "${line.ask}" (lines.json ${line.id}).`, ...(Object.hasOwn(entry, 'matches') ? { matches: entry.matches } : {}),
      });
      if (entry.rule) rules.push({ line: line.id, rule: entry.rule, splitFrom: entry.name.trim() });
    } else if (entry.kind === 'ask') asks.push({ line: line.id, ask: line.ask, placeIn: entry.placeIn });
    else rules.push({ line: line.id, rule: line.ask, splitFrom: null });
  }
  const areaKeys = new Set(areas.map((area) => area.key));
  for (const ask of asks) {
    if (ask.placeIn !== OTHER_FOCUS_AREA_ID && !areaKeys.has(ask.placeIn)) throw new TypeError(`Ask ${ask.line}: placeIn must be an area line or "${OTHER_FOCUS_AREA_ID}", not ${JSON.stringify(ask.placeIn)}.`);
  }
  const kindOf = Object.fromEntries(lines.map((line) => [line.id, byLine[line.id].kind]));
  /** The area key (or "other") a request Jev routed to this line goes to. */
  const areaKeyForLine = (lineId) => {
    if (lineId === null) return OTHER_FOCUS_AREA_ID;
    if (kindOf[lineId] === 'area') return lineId;
    if (kindOf[lineId] === 'ask') return asks.find((ask) => ask.line === lineId).placeIn;
    if (kindOf[lineId] === 'rule') throw new TypeError(`Jev routed a request to ${lineId}, which is classified a rule; a rule holds no requests. Classify it again.`);
    throw new TypeError(`Jev routed a request to ${JSON.stringify(lineId)}, which is not a line in lines.json.`);
  };
  return { areas, asks, rules, areaKeyForLine };
}

/** The evidence one placement carries: the line Jev chose and its recorded p, flagged unsure under UNSURE_P. */
export function placementEvidence(routed, areaKey) {
  const p = Math.round(routed.p * 100) / 100;
  const chose = routed.line === null ? `no line fits (p=${p} for none)` : `line "${routed.line}" (p=${p})${areaKey !== routed.line ? `, an ask filed in ${areaKey}` : ''}`;
  return `${SEED_EVIDENCE_PREFIX}Jev routed this request to ${chose}.${routed.p < UNSURE_P ? ` Unsure: p < ${UNSURE_P}.` : ''}`;
}

/**
 * Jev's routing keyed by anchor conversation. tree2.json names requests by the g_ id of the ledger it was routed from
 * (treeLedger); a g_ id is a hash of its anchor, so each maps back through that ledger and is checked against the hash.
 * Against the current ledger, each anchor is:
 * - a current request's anchor: placed;
 * - a conversation another current request holds that Jev routed on its own (that request's placement stands):
 *   absorbed, reported, not placed;
 * - anything else (no such group in treeLedger, a hash mismatch, or a conversation no routed current request holds):
 *   unmapped. Any unmapped request is refused with the full list; none is dropped.
 */
export function mapRoutedToAnchors(routed, treeLedger, currentLedger) {
  const routedIds = new Set(routed.map((entry) => entry.id));
  const mapped = [], absorbed = [], unmapped = [];
  for (const entry of routed) {
    const group = treeLedger.groups?.[entry.id];
    if (!group?.anchor) { unmapped.push({ id: entry.id, reason: 'not a group in the tree ledger' }); continue; }
    if (groupIdFor(group.anchor) !== entry.id) { unmapped.push({ id: entry.id, reason: 'its anchor does not hash to its id' }); continue; }
    if (currentLedger.groups?.[entry.id]?.anchor === group.anchor) { mapped.push({ routed: entry, anchorConversationKey: group.anchor }); continue; }
    const holder = currentLedger.conversations?.[group.anchor];
    if (holder && routedIds.has(holder)) { absorbed.push({ id: entry.id, holder, anchorConversationKey: group.anchor }); continue; }
    unmapped.push({ id: entry.id, reason: holder ? `held by ${holder}, which Jev did not route` : 'its conversation is in no current request' });
  }
  if (unmapped.length) throw new Error(`${unmapped.length} routed request(s) map to no current request: ${unmapped.map((item) => `${item.id} (${item.reason})`).join('; ')}.`);
  const notRouted = Object.keys(currentLedger.groups ?? {}).filter((id) => !routedIds.has(id));
  return { mapped, absorbed, notRouted };
}

/** The seed body (POST /api/work-view/focus/seed, action apply) and what the dry run reports about it. */
export function buildSeed({ lines, classification, tree, treeLedger, currentLedger }) {
  const loaded = loadClassification(lines, classification);
  const { mapped, absorbed, notRouted } = mapRoutedToAnchors(tree.routed, treeLedger, currentLedger);
  const placements = mapped.map(({ routed, anchorConversationKey }) => {
    const area = loaded.areaKeyForLine(routed.line);
    // The request's focus basis, so the focus step places it again once it changes (focusDue).
    const basis = focusBasis({ groups: currentLedger }, routed.id);
    return { anchorConversationKey, area, confidence: routed.p, basis, evidence: placementEvidence(routed, area), unsure: routed.p < UNSURE_P, groupId: routed.id };
  });
  const body = { action: 'apply', areas: loaded.areas, placements: placements.map(({ unsure, groupId, ...placement }) => placement) };
  return { body, placements, loaded, absorbed, notRouted, routedCount: tree.routed.length };
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new TypeError(`--${name} needs a value.`);
  return value;
}
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// The worker's sync device id as CloudSync persisted it, read the way request-groups-cli.mjs reads it.
const localDeviceIdOf = (dataDir) => SettingsDefaultsManager.loadFromFile(join(dataDir, 'settings.json'), true, { readOnly: true }).CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID ?? '';

function readFocusAt(dataDir) {
  const database = new Database(join(dataDir, 'claude-mem.db'), { readonly: true, create: false });
  try { return readFocus(database, { localDeviceId: localDeviceIdOf(dataDir) }); } finally { database.close(); }
}

async function post(body) {
  const { resolveHarnessWorkerUrl } = await import('../src/integrations/harness-worker.ts');
  const base = resolveHarnessWorkerUrl();
  const response = await fetch(`${base}/api/work-view/focus/seed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`The worker at ${base} refused the seed (${response.status}): ${text}`);
  return { base, result: JSON.parse(text) };
}

function printPlan(seed, plan, focus) {
  const { loaded, placements, absorbed, notRouted } = seed;
  const nameOf = (focusAreaId) => focusAreaId === OTHER_FOCUS_AREA_ID ? 'Other' : loaded.areas.find((area) => plan.focusAreaIds[area.key] === focusAreaId)?.name ?? focusAreaId;
  const counts = new Map();
  for (const placement of plan.placed) counts.set(placement.focusAreaId, (counts.get(placement.focusAreaId) ?? 0) + 1);
  const unsure = new Set(placements.filter((placement) => placement.unsure).map((placement) => placement.anchorConversationKey));
  const unsureBy = new Map();
  for (const placement of plan.placed) if (unsure.has(placement.anchorConversationKey)) unsureBy.set(placement.focusAreaId, (unsureBy.get(placement.focusAreaId) ?? 0) + 1);
  console.log(`Saved focus areas now: ${focus.focusAreas.length}. Seed areas (suggested, source seed):`);
  for (const area of loaded.areas) {
    const id = plan.focusAreaIds[area.key];
    console.log(`  ${String(area.priorityRank).padStart(2)}. ${area.name.padEnd(22)} ${String(counts.get(id) ?? 0).padStart(3)} placed${unsureBy.get(id) ? ` (${unsureBy.get(id)} unsure)` : ''}  — ${area.goal}${area.matches ? ` [matches ${area.matches}]` : ''}`);
  }
  console.log(`  Other${' '.repeat(22)}${String(counts.get(OTHER_FOCUS_AREA_ID) ?? 0).padStart(3)} placed${unsureBy.get(OTHER_FOCUS_AREA_ID) ? ` (${unsureBy.get(OTHER_FOCUS_AREA_ID)} unsure)` : ''}`);
  console.log('Asks (requests, not areas):');
  for (const ask of loaded.asks) console.log(`  ${ask.line}: "${ask.ask}" -> ${ask.placeIn === OTHER_FOCUS_AREA_ID ? 'Other' : loaded.areas.find((area) => area.key === ask.placeIn).name}`);
  console.log('Rules (not written by the seed; they belong to My Rules):');
  for (const rule of loaded.rules) console.log(`  ${rule.line}: ${rule.rule}${rule.splitFrom ? ` (split from the area ${rule.splitFrom})` : ''}`);
  console.log(`Routed requests: ${seed.routedCount}. Mapped to a current request's anchor: ${placements.length}. Absorbed into another routed request: ${absorbed.length}. Unmapped: 0.`);
  for (const item of absorbed) console.log(`  absorbed ${item.id} -> ${item.holder}`);
  console.log(`Placements to write: ${plan.placed.length} (${unsure.size} flagged unsure, p < ${UNSURE_P}). Already placed, left as they are: ${plan.skipped.length}.`);
  for (const item of plan.skipped) console.log(`  skipped ${item.anchorConversationKey} (${item.placedBy} placed it in ${item.focusAreaId})`);
  console.log(`Current requests Jev never routed (left for the focus step): ${notRouted.length}.`);
}

async function main(args) {
  const dataDir = resolve(process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem'));
  const undoNote = option(args, 'undo');
  if (undoNote) {
    const note = readJson(undoNote);
    const body = { action: 'undo', focusAreaIds: note.focusAreaIds.map((area) => area.focusAreaId), placements: note.placements, databasePath: join(dataDir, 'claude-mem.db') };
    const plan = seedUndoRows(body, readFocusAt(dataDir));
    console.log(`Undo plan (${dataDir}): withdraw ${plan.withdrawn.length} areas, clear ${plan.cleared.length} placements; areas left as the owner's: ${plan.leftByOwner.length} decided, ${plan.leftInOwnerUse.length} in use; placements left in them: ${plan.leftInOwnerArea.length}; placements a later step replaced, left: ${plan.replaced.length}.`);
    const { base, result } = await post(body);
    const focus = readFocusAt(dataDir);
    const stillLive = result.withdrawn.filter((id) => focus.focusAreas.find((area) => area.focusAreaId === id)?.status !== 'dismissed');
    if (stillLive.length) throw new Error(`The worker at ${base} answered, but ${dataDir} still shows ${stillLive.join(', ')} live: it serves another data folder.`);
    console.log(JSON.stringify({ worker: base, ...result }, null, 2));
    return;
  }
  const scratch = join(dirname(new URL(import.meta.url).pathname), '..', '.scratch', 'my-focus');
  const treeLedgerPath = option(args, 'tree-ledger');
  if (!treeLedgerPath) throw new TypeError('--tree-ledger is required: the request-groups.json tree2.json was routed from (its g_ ids are that ledger\'s).');
  const seed = buildSeed({
    lines: readJson(option(args, 'lines') ?? join(scratch, 'lines.json')),
    classification: readJson(option(args, 'classification') ?? join(scratch, 'seed-classification.json')),
    tree: readJson(option(args, 'tree') ?? join(scratch, 'tree2.json')),
    treeLedger: readJson(treeLedgerPath),
    currentLedger: readJson(join(dataDir, 'work-view', 'request-groups.json')),
  });
  const focus = readFocusAt(dataDir);
  let fakeId = 0;
  const plan = seedFocusRows(seed.body, focus, () => `fa_dryrun${++fakeId}`);
  console.log(`${args.includes('--apply') ? 'Applying' : 'Dry run'} against ${dataDir}`);
  printPlan(seed, plan, focus);
  if (!args.includes('--apply')) { console.log('Dry run: nothing written. Add --apply to write.'); return; }
  const { base, result } = await post({ ...seed.body, databasePath: join(dataDir, 'claude-mem.db') });
  const after = readFocusAt(dataDir);
  const missing = result.created.filter((id) => !after.focusAreas.some((area) => area.focusAreaId === id));
  if (missing.length) throw new Error(`The worker at ${base} answered, but ${dataDir} has no ${missing.join(', ')}: it serves another data folder.`);
  const noteDir = join(dataDir, 'work-view', 'focus-seed');
  mkdirSync(noteDir, { recursive: true });
  const notePath = join(noteDir, `seed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const note = {
    appliedAt: new Date().toISOString(), worker: base,
    focusAreaIds: result.created.map((focusAreaId) => ({ focusAreaId, line: Object.entries(result.focusAreaIds).find(([, id]) => id === focusAreaId)[0] })),
    placements: result.placed, skipped: result.skipped,
  };
  writeFileSync(notePath, `${JSON.stringify(note, null, 2)}\n`);
  console.log(`Wrote ${result.rows} rows through ${base}: ${result.created.length} areas, ${result.placed.length} placements. Undo note: ${notePath}`);
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
