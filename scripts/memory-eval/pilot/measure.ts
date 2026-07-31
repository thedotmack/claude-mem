// SPDX-License-Identifier: Apache-2.0

/**
 * e5 pilot — measurement (step 3b).
 *
 * For every gold.json query:
 *   - FTS top-5  — the EXACT harness path (ftsPool limit 50 → rankPool
 *                  'recency' → top 5), same code as `run.ts eval`, so the
 *                  baseline is apple-to-apple with the reported 21.0%;
 *   - e5 top-5   — read from `e5-top5.json` produced by embed.py (both
 *                  'plain' and 'prefixed' variants).
 *
 * Metrics: hit-rate@5 per approach, RU/EN split (Cyrillic heuristic on the
 * prompt), mean top-5 overlap between approaches, per-query win/loss lists.
 * Writes `pilot-results.json` next to this script.
 *
 *   bun scripts/memory-eval/pilot/measure.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { openReadonlyDb, loadGold } from '../lib/common.js';
import { hitRateAtK, hitVector } from '../lib/metrics.js';
import { ftsPool, rankPool } from '../lib/retrieve.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const E5_PATH = join(HERE, 'e5-top5.json');
const OUT_PATH = join(HERE, 'pilot-results.json');

const K = 5;
const POOL_LIMIT = 50;

interface E5TopEntry { id: number; score: number }
interface E5PerQuery { promptId: number; top: E5TopEntry[] }
interface E5File {
  model: string;
  variants: Record<'plain' | 'prefixed', E5PerQuery[]>;
}

const isRussian = (text: string): boolean => /[а-яА-ЯёЁ]/.test(text);
const pct = (x: number) => (x * 100).toFixed(1) + '%';

function overlap(a: number[], b: number[]): number {
  const sb = new Set(b);
  return a.filter(x => sb.has(x)).length;
}

const gold = loadGold();
const items = gold.items;
const e5: E5File = JSON.parse(readFileSync(E5_PATH, 'utf-8'));

// --- FTS baseline: same pool+ranker as `run.ts eval` (recency, k=5) ---
const db = openReadonlyDb();
const ftsTop5: number[][] = [];
try {
  for (const item of items) {
    const pool = ftsPool(db, item.promptText, item.project, POOL_LIMIT);
    ftsTop5.push(rankPool(pool, 'recency', K).map(r => r.id));
  }
} finally {
  db.close();
}

const e5Top5: Record<'plain' | 'prefixed', number[][]> = { plain: [], prefixed: [] };
const e5Scores: Record<'plain' | 'prefixed', Map<number, E5TopEntry[]>> = { plain: new Map(), prefixed: new Map() };
for (const variant of ['plain', 'prefixed'] as const) {
  const byPrompt = new Map(e5.variants[variant].map(q => [q.promptId, q.top]));
  for (const item of items) {
    const top = byPrompt.get(item.promptId) ?? [];
    e5Top5[variant].push(top.map(t => t.id));
    e5Scores[variant].set(item.promptId, top);
  }
}

const goldIds = items.map(i => i.relevantIds);
const approaches = {
  fts: ftsTop5,
  'e5-plain': e5Top5.plain,
  'e5-prefixed': e5Top5.prefixed,
} as const;

type ApproachName = keyof typeof approaches;
const hits: Record<ApproachName, boolean[]> = {
  fts: hitVector(ftsTop5, goldIds, K),
  'e5-plain': hitVector(e5Top5.plain, goldIds, K),
  'e5-prefixed': hitVector(e5Top5.prefixed, goldIds, K),
};

// --- aggregate + language split ---
const langOf = items.map(i => (isRussian(i.promptText) ? 'ru' : 'en'));
function splitHitRate(ranked: number[][], lang: 'ru' | 'en' | 'all'): number {
  const idx = items.map((_, i) => i).filter(i => lang === 'all' || langOf[i] === lang);
  if (idx.length === 0) return 0;
  return hitRateAtK(idx.map(i => ranked[i]), idx.map(i => goldIds[i]), K);
}

const summary: Record<string, unknown> = {};
for (const name of Object.keys(approaches) as ApproachName[]) {
  summary[name] = {
    all: Number(splitHitRate(approaches[name], 'all').toFixed(3)),
    ru: Number(splitHitRate(approaches[name], 'ru').toFixed(3)),
    en: Number(splitHitRate(approaches[name], 'en').toFixed(3)),
  };
}

const langCounts = {
  ru: langOf.filter(l => l === 'ru').length,
  en: langOf.filter(l => l === 'en').length,
};

// --- overlap (mean shared ids in top-5) ---
function meanOverlap(a: number[][], b: number[][]): number {
  if (a.length === 0) return 0;
  return a.reduce((acc, ids, i) => acc + overlap(ids, b[i]) / K, 0) / a.length;
}
const overlaps = {
  'fts vs e5-plain': Number(meanOverlap(ftsTop5, e5Top5.plain).toFixed(3)),
  'fts vs e5-prefixed': Number(meanOverlap(ftsTop5, e5Top5.prefixed).toFixed(3)),
  'e5-plain vs e5-prefixed': Number(meanOverlap(e5Top5.plain, e5Top5.prefixed).toFixed(3)),
};

// --- win/loss examples (vs FTS) ---
interface Example {
  promptId: number;
  lang: string;
  prompt: string;
  goldIds: number[];
  ftsTop5: number[];
  e5Top5: E5TopEntry[];
}
function examples(winVariant: 'e5-plain' | 'e5-prefixed', win: boolean): Example[] {
  const out: Example[] = [];
  for (let i = 0; i < items.length; i++) {
    const e5Hit = hits[winVariant][i];
    const ftsHit = hits.fts[i];
    if (win ? (e5Hit && !ftsHit) : (!e5Hit && ftsHit)) {
      out.push({
        promptId: items[i].promptId,
        lang: langOf[i],
        prompt: items[i].promptText.slice(0, 300),
        goldIds: goldIds[i].slice(0, 10),
        ftsTop5: ftsTop5[i],
        e5Top5: e5Scores[winVariant === 'e5-plain' ? 'plain' : 'prefixed'].get(items[i].promptId) ?? [],
      });
    }
  }
  return out;
}

const results = {
  generatedAt: new Date().toISOString(),
  model: e5.model,
  k: K,
  poolLimit: POOL_LIMIT,
  queries: items.length,
  langCounts,
  hitRateAt5: summary,
  top5Overlap: overlaps,
  wins: { 'e5-plain': examples('e5-plain', true), 'e5-prefixed': examples('e5-prefixed', true) },
  losses: { 'e5-plain': examples('e5-plain', false), 'e5-prefixed': examples('e5-prefixed', false) },
};
writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));

console.log(`queries: ${items.length} (ru=${langCounts.ru}, en=${langCounts.en})`);
for (const name of Object.keys(approaches) as ApproachName[]) {
  const s = summary[name] as { all: number; ru: number; en: number };
  console.log(`${name.padEnd(12)} hit-rate@5 all=${pct(s.all)}  ru=${pct(s.ru)}  en=${pct(s.en)}`);
}
console.log('top-5 overlap:', JSON.stringify(overlaps));
console.log(`e5-plain wins vs FTS: ${results.wins['e5-plain'].length}, losses: ${results.losses['e5-plain'].length}`);
console.log(`report data → ${OUT_PATH}`);
