// SPDX-License-Identifier: Apache-2.0

/**
 * e5 pilot — candidate export (step 1).
 *
 * Dumps all ACTIVE observations (id, project, title, narrative, facts,
 * concepts) and all ACTIVE semantic_facts (id, fact, kind) from the
 * production DB into `observations.jsonl` next to this script. One JSON
 * object per line, discriminated by `record`:
 *
 *   {"record":"observation","id":...,"project":...,"merged_into_project":...,
 *    "title":...,"narrative":...,"facts":...,"concepts":...}
 *   {"record":"fact","id":...,"project":...,"kind":...,"fact":...}
 *
 * The production DB is opened READONLY only (`PRAGMA query_only`).
 *
 *   bun scripts/memory-eval/pilot/export.ts
 */

import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { openReadonlyDb } from '../lib/common.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(HERE, 'observations.jsonl');

interface ObsRow {
  id: number;
  project: string;
  merged_into_project: string | null;
  title: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
}

interface FactRow {
  id: number;
  project: string;
  kind: string;
  fact: string;
}

const db = openReadonlyDb();
try {
  const observations = db.prepare(`
    SELECT id, project, merged_into_project, title, narrative, facts, concepts
    FROM observations
    WHERE superseded_by IS NULL
    ORDER BY id
  `).all() as ObsRow[];

  const facts = db.prepare(`
    SELECT id, project, kind, fact
    FROM semantic_facts
    WHERE superseded_by IS NULL AND invalidated_at IS NULL
    ORDER BY id
  `).all() as FactRow[];

  const lines: string[] = [];
  for (const o of observations) {
    lines.push(JSON.stringify({
      record: 'observation',
      id: o.id,
      project: o.project,
      merged_into_project: o.merged_into_project,
      title: o.title,
      narrative: o.narrative,
      facts: o.facts,
      concepts: o.concepts,
    }));
  }
  for (const f of facts) {
    lines.push(JSON.stringify({
      record: 'fact',
      id: f.id,
      project: f.project,
      kind: f.kind,
      fact: f.fact,
    }));
  }
  writeFileSync(OUT_PATH, lines.join('\n') + '\n');
  console.log(`exported ${observations.length} observations + ${facts.length} facts → ${OUT_PATH}`);
} finally {
  db.close();
}
