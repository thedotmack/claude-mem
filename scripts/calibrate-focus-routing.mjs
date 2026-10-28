#!/usr/bin/env bun
// Calibrates the focus judge (src/services/work-view/focus-judge.mjs) against the owner's own placements, before any
// FOCUS_AUTO_PLACE_THRESHOLD ships (PLAN.md Phase 4). Read-only: it writes nothing to the database or the ledger.
//
//   bun scripts/calibrate-focus-routing.mjs --dry-run   list the labeled pairs, ask nothing
//   bun scripts/calibrate-focus-routing.mjs             ask Jev for each labeled request, print precision/recall per cutoff
//
// Labels come from the live my-focus rows (work_state_entries, list_name 'my-focus'), replayed in write order: an owner
// placement into area A is a positive pair (request, A), and the area the router had the request in before it, when
// different, is a negative pair (request, that area). Router placements alone are never labels: the seed placements
// came from Jev itself (tree2.json), so scoring Jev against them would be circular. Jev is asked over today's kept
// areas, the question the refresh asks; a pair whose area is no longer kept (or Other) cannot be asked and is counted.
// With fewer than MIN_OWNER_LABELED_PAIRS pairs the script says so and exits 0 without recommending a cutoff.
//
// Data folder: CLAUDE_MEM_DATA_DIR (default ~/.claude-mem); database: CLAUDE_MEM_DB (default <data>/claude-mem.db).
import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { askFocusArea, MIN_OWNER_LABELED_PAIRS, requestContexts } from '../src/services/work-view/focus-judge.mjs';
import { MY_FOCUS_LIST, OTHER_FOCUS_AREA_ID, buildFocusAreas } from '../src/services/work-view/my-focus.mjs';
import { readLedger } from '../src/services/work-view/request-groups.mjs';
import { jevClientFromSettings } from '../src/services/work-view/request-judge.mjs';
import { reduceWorkState } from '../src/services/work-view/work-state-reduce.mjs';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.ts';

/** The cutoffs the table is printed at: every tenth from 0.5 to 0.9, plus 0.95 to split the top band. Below 0.5 Jev
 * itself rates its pick less likely than not, which is no ground for placing a request without the agent. */
const CUTOFFS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95];

const dataDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
const databasePath = process.env.CLAUDE_MEM_DB || join(dataDir, 'claude-mem.db');
const settings = SettingsDefaultsManager.loadFromFile(join(dataDir, 'settings.json'), true, { readOnly: true });
const dryRun = process.argv.includes('--dry-run');

/** Positive and negative pairs from the owner's placements, oldest first, as the rows replayed. */
function labeledPairs(state, focus) {
  const routerArea = new Map(), pairs = [];
  for (const event of [...state.events].reverse()) {
    if (event.listName !== MY_FOCUS_LIST || !event.task?.startsWith('Placement: ')) continue;
    const anchor = event.fields.anchor_conversation_key ?? event.task.slice('Placement: '.length);
    const area = event.fields.focus_area_id;
    if (typeof area !== 'string' || !area) continue;
    const resolved = area === OTHER_FOCUS_AREA_ID ? area : focus.resolveFocusAreaId(area) ?? area;
    if (event.fields.placed_by === 'router') { routerArea.set(anchor, resolved); continue; }
    if (event.fields.placed_by !== 'owner') throw new Error(`A placement has an unknown writer: ${event.fields.placed_by}`);
    pairs.push({ anchor, focusAreaId: resolved, label: true, at: event.at });
    const before = routerArea.get(anchor);
    if (before && before !== resolved) pairs.push({ anchor, focusAreaId: before, label: false, at: event.at });
  }
  return pairs;
}

async function main(database) {
  const rows = database.prepare('SELECT * FROM work_state_entries WHERE list_name = ?').all(MY_FOCUS_LIST);
  const state = reduceWorkState(rows, { localDeviceId: settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID ?? '' });
  const focus = buildFocusAreas(state);
  const kept = focus.focusAreas.filter((area) => area.status === 'kept' && !area.mergedInto);
  const placements = rows.map((row) => JSON.parse(row.fields)).filter((fields) => String(fields.task ?? '').startsWith('Placement: '));
  const count = (writer) => placements.filter((fields) => fields.placed_by === writer).length;
  const pairs = labeledPairs(state, focus);
  const askable = (pair) => pair.focusAreaId === OTHER_FOCUS_AREA_ID || kept.some((area) => area.focusAreaId === pair.focusAreaId);
  const asked = pairs.filter(askable);
  console.log(`Database: ${databasePath}`);
  console.log(`my-focus rows: ${rows.length}; placement rows: ${placements.length} (owner ${count('owner')}, router ${count('router')}); kept areas: ${kept.length}`);
  console.log(`Labeled pairs: ${pairs.length} (${pairs.filter((pair) => pair.label).length} positive, ${pairs.filter((pair) => !pair.label).length} negative); askable over today's kept areas: ${asked.length}`);
  for (const pair of pairs) console.log(`  ${pair.label ? '+' : '-'} ${pair.at} ${pair.anchor} -> ${pair.focusAreaId}${askable(pair) ? '' : ' (area no longer kept: not asked)'}`);
  if (asked.length < MIN_OWNER_LABELED_PAIRS) {
    console.log(`\nNot enough owner-labeled pairs: ${asked.length} askable, and a cutoff needs at least ${MIN_OWNER_LABELED_PAIRS} (MIN_OWNER_LABELED_PAIRS in focus-judge.mjs).`);
    console.log('No cutoff is recommended; FOCUS_AUTO_PLACE_THRESHOLD stays null and every Jev pick stays a suggestion.');
    return;
  }
  if (dryRun) { console.log('\nDry run: Jev was not asked.'); return; }
  const client = jevClientFromSettings(settings);
  if (!client) throw new Error('This install has no Jev client (CMEM Pro gateway or OpenRouter with a key); nothing can be asked.');
  const ledger = readLedger(join(dataDir, 'work-view'));
  const titles = new Map(Object.values(ledger.groups.groups).map((group) => [group.anchor, group.title]));
  const anchors = [...new Set(asked.map((pair) => pair.anchor))];
  const contexts = requestContexts(database, ledger, anchors.map((anchor) => ({ anchor, title: titles.get(anchor) ?? null })));
  const picks = new Map();
  for (const anchor of anchors) {
    // One question per labeled request, no retry; a failure is reported and that request's pairs are left out.
    try { picks.set(anchor, await askFocusArea(client, contexts.get(anchor), kept)); }
    catch (error) { console.log(`  ! ${anchor}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const scored = asked.filter((pair) => picks.has(pair.anchor));
  console.log(`\nJev answered for ${picks.size} of ${anchors.length} requests; ${scored.length} pairs scored.`);
  console.log('cutoff  TP  FP  FN  precision  recall   (a pair is predicted when Jev picks its area at or above the cutoff)');
  for (const cutoff of CUTOFFS) {
    let tp = 0, fp = 0, fn = 0;
    for (const pair of scored) {
      const pick = picks.get(pair.anchor);
      const predicted = pick.focusAreaId === pair.focusAreaId && pick.confidence >= cutoff;
      if (pair.label && predicted) tp++; else if (pair.label) fn++; else if (predicted) fp++;
    }
    const ratio = (a, b) => (b ? (a / b).toFixed(2) : '  -  ');
    console.log(`${cutoff.toFixed(2).padStart(6)}  ${String(tp).padStart(2)}  ${String(fp).padStart(2)}  ${String(fn).padStart(2)}  ${ratio(tp, tp + fp).padStart(9)}  ${ratio(tp, tp + fn).padStart(6)}`);
  }
}

const database = new Database(databasePath, { readonly: true, create: false });
try { await main(database); } finally { database.close(); }
