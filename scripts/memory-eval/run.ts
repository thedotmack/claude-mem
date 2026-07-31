// SPDX-License-Identifier: Apache-2.0

/**
 * memory-eval — quality harness for the claude-mem memory system.
 *
 *   bun scripts/memory-eval/run.ts build-gold [--limit N] [--no-judge]
 *   bun scripts/memory-eval/run.ts eval [--d <value>] [--ranker recency|actr|both]
 *                                       [--retrieval fts|hybrid] [--limit N] [--no-judge]
 *   bun scripts/memory-eval/run.ts fit-d [--grid 0.2..1.0] [--step 0.1] [--limit N]
 *   bun scripts/memory-eval/run.ts mutation-test
 *   bun scripts/memory-eval/run.ts erasure-test
 *
 * Hard rules: the production DB is only ever opened READONLY; mutations run on
 * temp copies; LLM judge calls go through createSdkJudge with a disk cache and
 * the spent-call count is reported.
 */

import { DB_PATH } from '../../src/shared/paths.js';
import { supersedeObservation } from '../../src/services/reinforcement/persist.js';
import { parseReinforcementDates, isoDay } from '../../src/services/reinforcement/strength.js';
import { queryObservationsMulti } from '../../src/services/context/ObservationCompiler.js';
import type { ContextConfig } from '../../src/services/context/types.js';
import {
  openReadonlyDb, copyDbToTemp, parseFlags, flagInt, flagFloat,
  loadGold, saveGold, estimateTokens, Report, type Flags, type GoldItem,
} from './lib/common.js';
import {
  hitRateAtK, hitVector, meanTokens, meanRelevance, disagreementCount,
  saturationRate, parseGrid,
} from './lib/metrics.js';
import { ftsPool, hybridPool, recentBlockIds, rankPool, type PoolRow, type RankerName } from './lib/retrieve.js';
import { CachedJudge } from './lib/judge.js';
import { buildGold } from './lib/gold.js';

const K = 5;
const POOL_LIMIT = 50;
const RECENT_BLOCK = 20;

// ---------------------------------------------------------------------------
// build-gold
// ---------------------------------------------------------------------------

async function cmdBuildGold(flags: Flags): Promise<void> {
  const limit = flagInt(flags, 'limit', 50);
  const noJudge = Boolean(flags['no-judge']);
  const judge = noJudge ? null : new CachedJudge();

  const db = openReadonlyDb();
  const report = new Report();
  const gold = await buildGold(db, { limit, judge, dbPath: DB_PATH });
  db.close();
  saveGold(gold);

  const projects = new Set(gold.items.map(i => i.project));
  const avgRelevant = gold.items.length
    ? gold.items.reduce((a, i) => a + i.relevantIds.length, 0) / gold.items.length
    : 0;

  report.json.command = 'build-gold';
  report.json.config = { limit, judge: !noJudge };
  report.json.gold = {
    items: gold.itemCount,
    projects: projects.size,
    judgeUsed: gold.judgeUsed,
    avgRelevantIdsPerItem: Number(avgRelevant.toFixed(2)),
  };
  report.json.judge = { callsSpent: judge?.callsSpent ?? 0, cacheHits: judge?.cacheHits ?? 0 };

  report.line(`## Gold set`);
  report.line();
  report.line(`- items (prompts): **${gold.itemCount}** (limit ${limit})`);
  report.line(`- projects covered: ${projects.size}`);
  report.line(`- scoring target: ${gold.judgeUsed ? 'LLM-judge-confirmed observation ids' : 'session-linkage ids only (--no-judge)'}`);
  report.line(`- avg relevant ids / item: ${avgRelevant.toFixed(2)}`);
  report.line(`- judge calls spent: **${judge?.callsSpent ?? 0}** (cache hits: ${judge?.cacheHits ?? 0})`);
  report.line(`- saved to \`scripts/memory-eval/gold.json\``);

  const { mdPath } = report.write('build-gold');
  console.log(`gold set: ${gold.itemCount} items, judge calls spent: ${judge?.callsSpent ?? 0}`);
  console.log(`report: ${mdPath}`);
}

// ---------------------------------------------------------------------------
// eval
// ---------------------------------------------------------------------------

interface RankerAcc {
  rankedIds: number[][];
  costs: number[];
  judgeCounts: number[];
}

async function cmdEval(flags: Flags): Promise<void> {
  const gold = loadGold();
  const limit = flagInt(flags, 'limit', gold.items.length);
  const powerD = flags.d !== undefined ? flagFloat(flags, 'd', 0.5) : undefined;
  const rankerFlag = String(flags.ranker ?? 'both');
  const rankers: RankerName[] = rankerFlag === 'both' ? ['recency', 'actr'] : [rankerFlag as RankerName];
  const retrieval = String(flags.retrieval ?? 'fts');
  const noJudge = Boolean(flags['no-judge']);

  const items = gold.items.slice(0, limit);
  const db = openReadonlyDb();
  const report = new Report();
  const judge = noJudge ? null : new CachedJudge();

  const acc: Record<string, RankerAcc> = {};
  for (const r of rankers) acc[r] = { rankedIds: [], costs: [], judgeCounts: [] };
  const recentBlocks: number[][] = [];
  let emptyPools = 0;

  for (const item of items) {
    const pool = retrieval === 'hybrid'
      ? await hybridPool(db, item.promptText, item.project, POOL_LIMIT, report.notes)
      : ftsPool(db, item.promptText, item.project, POOL_LIMIT);
    if (pool.length === 0) emptyPools++;
    recentBlocks.push(recentBlockIds(db, item.project, RECENT_BLOCK));

    for (const r of rankers) {
      const top = rankPool(pool, r, K, powerD);
      acc[r].rankedIds.push(top.map(t => t.id));
      acc[r].costs.push(top.reduce((a, t) => a + estimateTokens(t), 0));
      if (judge) {
        acc[r].judgeCounts.push(await judge.relevanceCount(item.promptText, top));
      }
    }
  }
  db.close();

  const goldIds = items.map(i => i.relevantIds);
  const pct = (x: number) => (x * 100).toFixed(1) + '%';

  report.json.command = 'eval';
  report.json.config = { k: K, poolLimit: POOL_LIMIT, rankers, retrieval, powerD: powerD ?? 'env/default', judge: !noJudge, goldBuiltWithJudge: gold.judgeUsed };
  report.json.queries = items.length;
  report.json.poolCoverage = items.length ? Number(((items.length - emptyPools) / items.length).toFixed(3)) : 0;
  report.json.saturation = { recentBlockSize: RECENT_BLOCK, fraction: Number(saturationRate(recentBlocks, goldIds).toFixed(3)) };
  report.json.judge = { callsSpent: judge?.callsSpent ?? 0, cacheHits: judge?.cacheHits ?? 0 };

  report.line(`## Eval (k=${K}, retrieval=${retrieval}, pool=${POOL_LIMIT})`);
  report.line();
  report.line(`- queries: ${items.length} (gold built ${gold.builtAt}, judge-confirmed: ${gold.judgeUsed})`);
  report.line(`- FTS pool coverage: ${items.length - emptyPools}/${items.length} queries have a non-empty pool`);
  report.line(`- saturation (rule 5): gold already in top-${RECENT_BLOCK} recency block for **${pct(saturationRate(recentBlocks, goldIds))}** of queries`);
  report.line(`- judge calls spent: **${judge?.callsSpent ?? 0}** (cache hits: ${judge?.cacheHits ?? 0})`);
  report.line();
  report.line(`| ranker | hit-rate@${K} (lexical) | judge relevance@${K} | tokens/query | disagreement |`);
  report.line(`| --- | --- | --- | --- | --- |`);

  const resultsJson: Record<string, unknown> = {};
  for (const r of rankers) {
    const a = acc[r];
    const hit = hitRateAtK(a.rankedIds, goldIds, K);
    const tokens = meanTokens(a.costs);
    let judgeRel: number | null = null;
    let disagree: number | null = null;
    if (judge) {
      judgeRel = meanRelevance(a.judgeCounts, K);
      disagree = disagreementCount(hitVector(a.rankedIds, goldIds, K), a.judgeCounts);
    }
    resultsJson[r] = {
      hitRateAtK: Number(hit.toFixed(3)),
      judgeRelevanceAtK: judgeRel === null ? null : Number(judgeRel.toFixed(3)),
      tokensPerQuery: Number(tokens.toFixed(1)),
      disagreementQueries: disagree,
    };
    report.line(
      `| ${r}${r === 'actr' ? ` (d=${powerD ?? 'default'})` : ''} | ${pct(hit)} | ${judgeRel === null ? '— (no-judge)' : pct(judgeRel)} | ${tokens.toFixed(0)} | ${disagree === null ? '—' : `${disagree}/${items.length}`} |`,
    );
  }
  report.json.results = resultsJson;

  const { mdPath } = report.write('eval');
  console.log(`eval done: ${items.length} queries, judge calls spent: ${judge?.callsSpent ?? 0}`);
  for (const r of rankers) {
    console.log(`  ${r}: hit-rate@${K} = ${pct(hitRateAtK(acc[r].rankedIds, goldIds, K))}`);
  }
  console.log(`report: ${mdPath}`);
}

// ---------------------------------------------------------------------------
// fit-d
// ---------------------------------------------------------------------------

async function cmdFitD(flags: Flags): Promise<void> {
  const gold = loadGold();
  const limit = flagInt(flags, 'limit', gold.items.length);
  const grid = parseGrid(typeof flags.grid === 'string' ? flags.grid : undefined, flagFloat(flags, 'step', 0.1));
  const items = gold.items.slice(0, limit);

  const db = openReadonlyDb();
  const pools: PoolRow[][] = items.map(i => ftsPool(db, i.promptText, i.project, POOL_LIMIT));
  db.close();

  const goldIds = items.map(i => i.relevantIds);
  const recencyHit = hitRateAtK(
    pools.map(p => rankPool(p, 'recency', K).map(t => t.id)),
    goldIds, K,
  );

  const rows = grid.map(d => {
    const hit = hitRateAtK(
      pools.map(p => rankPool(p, 'actr', K, d).map(t => t.id)),
      goldIds, K,
    );
    return { d, hit };
  });
  const best = rows.reduce((a, b) => (b.hit > a.hit ? b : a), rows[0]);

  const pct = (x: number) => (x * 100).toFixed(1) + '%';
  const report = new Report();
  report.json.command = 'fit-d';
  report.json.config = { k: K, poolLimit: POOL_LIMIT, grid, queries: items.length, objective: `hit-rate@${K} against ${gold.judgeUsed ? 'judge-confirmed' : 'session-linkage'} gold` };
  report.json.recencyBaseline = Number(recencyHit.toFixed(3));
  report.json.rows = rows.map(r => ({ d: r.d, hitRateAtK: Number(r.hit.toFixed(3)) }));
  report.json.bestD = best.d;

  report.line(`## fit-d (objective: hit-rate@${K}, ${items.length} queries)`);
  report.line();
  report.line(`Recency-only baseline (upstream behaviour): **${pct(recencyHit)}**`);
  report.line();
  report.line(`| d | ACT-R hit-rate@${K} |`);
  report.line(`| --- | --- |`);
  for (const r of rows) report.line(`| ${r.d.toFixed(1)} | ${pct(r.hit)} |`);
  report.line();
  report.line(`**Best d = ${best.d.toFixed(1)}** (hit-rate@${K} = ${pct(best.hit)}); current default is 0.5.`);

  const { mdPath } = report.write('fit-d');
  console.log(`fit-d: best d = ${best.d.toFixed(1)} (${pct(best.hit)}), recency baseline ${pct(recencyHit)}`);
  for (const r of rows) console.log(`  d=${r.d.toFixed(1)}  hit-rate@${K}=${pct(r.hit)}`);
  console.log(`report: ${mdPath}`);
}

// ---------------------------------------------------------------------------
// mutation-test (rule 7) — on a temp copy of the real DB
// ---------------------------------------------------------------------------

function makeInjectConfig(type: string, concepts: string[]): ContextConfig {
  return {
    totalObservationCount: 50,
    fullObservationCount: 10,
    sessionCount: 0,
    factsInjectCount: 0,
    showReadTokens: false,
    showWorkTokens: false,
    showSavingsAmount: false,
    showSavingsPercent: false,
    observationTypes: new Set([type]),
    observationConcepts: new Set(concepts),
    fullObservationField: 'narrative',
    showLastSummary: false,
    showLastMessage: false,
  };
}

interface OldObsRow {
  id: number;
  memory_session_id: string;
  project: string;
  type: string;
  title: string | null;
  narrative: string | null;
  concepts: string | null;
  reinforcement_dates: string | null;
}

function pickMutationTarget(db: import('bun:sqlite').Database): OldObsRow | undefined {
  const base = `
    SELECT id, memory_session_id, project, type, title, narrative, concepts, reinforcement_dates
    FROM observations
    WHERE superseded_by IS NULL AND concepts IS NOT NULL AND concepts != '[]'
  `;
  const withHistory = db.prepare(
    `${base} AND reinforcement_dates IS NOT NULL AND json_array_length(reinforcement_dates) >= 2
     ORDER BY created_at_epoch DESC LIMIT 1`,
  ).get() as OldObsRow | undefined;
  return withHistory ?? db.prepare(`${base} ORDER BY created_at_epoch DESC LIMIT 1`).get() as OldObsRow | undefined;
}

async function cmdMutationTest(): Promise<void> {
  const report = new Report();
  const copy = copyDbToTemp();
  report.note(`mutations ran on temp copy ${copy.path}; production DB opened readonly only`);

  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  try {
    const old = pickMutationTarget(copy.db);
    if (!old) throw new Error('no suitable active observation found in the DB copy');

    const oldConcepts = JSON.parse(old.concepts ?? '[]') as string[];
    const oldDates = parseReinforcementDates(old.reinforcement_dates);
    const inherited = oldDates.slice(0, Math.ceil(oldDates.length / 2));

    // Insert the contradicting observation through the real write path.
    const { SessionStore } = await import('../../src/services/sqlite/SessionStore.js');
    const store = new SessionStore(copy.db);
    const replacement = store.storeObservation(old.memory_session_id, old.project, {
      type: old.type,
      title: `${old.title ?? 'fact'} (corrected)`,
      subtitle: null,
      facts: [],
      narrative: `memory-eval mutation test: this CONTRADICTS observation #${old.id} ("${old.title ?? ''}") — the original claim no longer holds; it has been replaced by the opposite.`,
      concepts: oldConcepts,
      files_read: [],
      files_modified: [],
    });

    const superseded = supersedeObservation(copy.db, old.id, replacement.id);
    checks.push({ name: 'supersedeObservation returns true', pass: superseded, detail: `old=#${old.id} new=#${replacement.id}` });

    const marked = copy.db.prepare('SELECT superseded_by FROM observations WHERE id = ?').get(old.id) as { superseded_by: number | null };
    checks.push({ name: 'old row marked superseded_by', pass: marked.superseded_by === replacement.id, detail: `superseded_by=${marked.superseded_by}` });

    const newDates = parseReinforcementDates(
      (copy.db.prepare('SELECT reinforcement_dates FROM observations WHERE id = ?').get(replacement.id) as { reinforcement_dates: string | null }).reinforcement_dates,
    );
    const inheritedOk = inherited.every(d => newDates.includes(d)) && newDates.includes(isoDay());
    checks.push({ name: 'successor inherits older half of reinforcement dates', pass: inheritedOk, detail: `old=${JSON.stringify(oldDates)} → new=${JSON.stringify(newDates)}` });

    const config = makeInjectConfig(old.type, oldConcepts);
    const pool = queryObservationsMulti({ db: copy.db }, [old.project], config);
    const poolIds = new Set(pool.map(o => o.id));
    checks.push({ name: 'superseded original dropped from injection pool (queryObservationsMulti)', pass: !poolIds.has(old.id), detail: `pool size ${pool.length}` });
    checks.push({ name: 'successor present in injection pool', pass: poolIds.has(replacement.id), detail: `pool size ${pool.length}` });
  } finally {
    copy.cleanup();
  }

  const passed = checks.filter(c => c.pass).length;
  report.json.command = 'mutation-test';
  report.json.checks = checks;
  report.json.passed = `${passed}/${checks.length}`;

  report.line(`## Mutation / obsolescence test (rule 7) — temp DB copy`);
  report.line();
  for (const c of checks) report.line(`- [${c.pass ? 'PASS' : 'FAIL'}] ${c.name} — ${c.detail}`);
  report.line();
  report.line(`**${passed}/${checks.length} checks passed**`);

  const { mdPath } = report.write('mutation-test');
  console.log(`mutation-test: ${passed}/${checks.length} passed`);
  for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
  console.log(`report: ${mdPath}`);
  if (passed !== checks.length) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// erasure-test (rule 8) — on a temp copy of the real DB
// ---------------------------------------------------------------------------

function distinctiveTerm(text: string | null): string | null {
  if (!text) return null;
  const words = text.match(/[A-Za-z0-9_]{5,}/g) ?? [];
  words.sort((a, b) => b.length - a.length);
  return words[0] ?? null;
}

async function cmdErasureTest(): Promise<void> {
  const report = new Report();
  const copy = copyDbToTemp();
  report.note(`erasure ran on temp copy ${copy.path}; production DB opened readonly only`);

  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  try {
    const { SessionSearch } = await import('../../src/services/sqlite/SessionSearch.js');
    const search = new SessionSearch(copy.db);

    // --- observation erasure ---
    // Pick an observation whose distinctive term actually retrieves it — a
    // high-frequency word can push the target past the search limit, which
    // would test the limit, not the erasure.
    const candidates = copy.db.prepare(`
      SELECT id, project, type, title, concepts FROM observations
      WHERE superseded_by IS NULL AND concepts IS NOT NULL AND concepts != '[]' AND title IS NOT NULL
      ORDER BY created_at_epoch DESC LIMIT 50
    `).all() as Array<{ id: number; project: string; type: string; title: string; concepts: string }>;

    let target: (typeof candidates)[number] | undefined;
    let term: string | null = null;
    let ftsBefore: number[] = [];
    for (const cand of candidates) {
      const t = distinctiveTerm(cand.title);
      if (!t) continue;
      const hits = search.searchObservations(t, { limit: 50 }).map(o => o.id);
      if (hits.includes(cand.id)) {
        target = cand;
        term = t;
        ftsBefore = hits;
        break;
      }
    }
    if (!target || !term) throw new Error('no erasable observation with an FTS-findable term found');

    const config = makeInjectConfig(target.type, JSON.parse(target.concepts) as string[]);
    const poolBefore = queryObservationsMulti({ db: copy.db }, [target.project], config).map(o => o.id);

    copy.db.prepare('DELETE FROM observations WHERE id = ?').run(target.id);

    const poolAfter = queryObservationsMulti({ db: copy.db }, [target.project], config).map(o => o.id);
    const ftsAfter = search.searchObservations(term, { limit: 50 }).map(o => o.id);

    checks.push({ name: `observation #${target.id} findable before erasure (FTS "${term}")`, pass: ftsBefore.includes(target.id), detail: `hits before: ${ftsBefore.length}` });
    checks.push({ name: 'observation absent from FTS search after erasure', pass: !ftsAfter.includes(target.id), detail: `hits after: ${ftsAfter.length}` });
    checks.push({ name: 'observation absent from injection pool after erasure', pass: poolBefore.includes(target.id) && !poolAfter.includes(target.id), detail: `pool ${poolBefore.length} → ${poolAfter.length}` });

    // --- fact erasure ---
    const factRows = copy.db.prepare(`
      SELECT id, project, fact FROM semantic_facts
      WHERE superseded_by IS NULL AND invalidated_at IS NULL
      ORDER BY id DESC LIMIT 20
    `).all() as Array<{ id: number; project: string; fact: string }>;
    let factDone = false;
    for (const fact of factRows) {
      const fterm = distinctiveTerm(fact.fact);
      if (!fterm) continue;
      const factsBefore = search.searchFacts(fterm, { project: fact.project, limit: 50 }).map(f => f.id);
      if (!factsBefore.includes(fact.id)) continue;
      copy.db.prepare('DELETE FROM semantic_facts WHERE id = ?').run(fact.id);
      const factsAfter = search.searchFacts(fterm, { project: fact.project, limit: 50 }).map(f => f.id);
      checks.push({ name: `fact #${fact.id} findable before erasure (FTS "${fterm}")`, pass: true, detail: '' });
      checks.push({ name: 'fact absent from fact search after erasure', pass: !factsAfter.includes(fact.id), detail: '' });
      factDone = true;
      break;
    }
    if (!factDone) {
      report.note('no active semantic fact with an FTS-findable term — fact erasure check skipped');
    }

    // --- provenance chain (read-only) ---
    const prov = copy.db.prepare(`
      SELECT id, project, kind, fact, source_observation_ids FROM semantic_facts
      WHERE superseded_by IS NULL AND invalidated_at IS NULL
        AND source_observation_ids IS NOT NULL AND source_observation_ids != '[]'
      ORDER BY id DESC LIMIT 1
    `).get() as { id: number; project: string; kind: string; fact: string; source_observation_ids: string } | undefined;
    if (prov) {
      const srcIds = JSON.parse(prov.source_observation_ids) as number[];
      const chain = srcIds.map(id => {
        const row = copy.db.prepare('SELECT id, title, superseded_by, created_at FROM observations WHERE id = ?').get(id) as
          { id: number; title: string | null; superseded_by: number | null; created_at: string } | undefined;
        return row
          ? `#${row.id} "${(row.title ?? '').slice(0, 60)}" (${row.created_at}${row.superseded_by ? `, superseded by #${row.superseded_by}` : ''})`
          : `#${id} MISSING`;
      });
      const resolved = chain.filter(c => !c.endsWith('MISSING')).length;
      checks.push({ name: `provenance chain resolves for fact #${prov.id}`, pass: resolved >= 1, detail: `${resolved}/${srcIds.length} sources resolve` });
      report.line(`## Provenance chain (fact #${prov.id}, kind=${prov.kind})`);
      report.line();
      report.line(`> ${prov.fact.slice(0, 200)}`);
      report.line();
      for (const c of chain) report.line(`- source observation ${c}`);
      report.line();
    } else {
      report.note('no active semantic fact with source_observation_ids — provenance check skipped');
    }
  } finally {
    copy.cleanup();
  }

  const passed = checks.filter(c => c.pass).length;
  report.json.command = 'erasure-test';
  report.json.checks = checks;
  report.json.passed = `${passed}/${checks.length}`;

  report.line(`## Erasure / provenance test (rule 8) — temp DB copy`);
  report.line();
  for (const c of checks) report.line(`- [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  report.line();
  report.line(`**${passed}/${checks.length} checks passed**`);

  const { mdPath } = report.write('erasure-test');
  console.log(`erasure-test: ${passed}/${checks.length} passed`);
  for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
  console.log(`report: ${mdPath}`);
  if (passed !== checks.length) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const USAGE = `memory-eval — memory quality harness

usage: bun scripts/memory-eval/run.ts <command> [flags]

commands:
  build-gold [--limit N] [--no-judge]        build gold set from the real DB (readonly)
  eval [--d D] [--ranker recency|actr|both] [--retrieval fts|hybrid] [--limit N] [--no-judge]
  fit-d [--grid 0.2..1.0] [--step 0.1] [--limit N]
  mutation-test                              supersede e2e on a temp DB copy
  erasure-test                               erasure + provenance on a temp DB copy
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (command) {
    case 'build-gold': return cmdBuildGold(flags);
    case 'eval': return cmdEval(flags);
    case 'fit-d': return cmdFitD(flags);
    case 'mutation-test': return cmdMutationTest();
    case 'erasure-test': return cmdErasureTest();
    default:
      console.log(USAGE);
      if (command) process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(`memory-eval failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
