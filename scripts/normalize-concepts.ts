#!/usr/bin/env npx tsx
/**
 * One-time cleanup script to normalize observation concept values.
 *
 * Fixes:
 * 1. Colon-prefixed concepts ("how-it-works: long description" -> "how-it-works")
 * 2. Invalid concepts (freeform text that doesn't match any valid concept ID)
 * 3. Observations with zero valid concepts (assigns inferred default from type)
 *
 * Usage:
 *   npx tsx scripts/normalize-concepts.ts           # Dry run (default)
 *   npx tsx scripts/normalize-concepts.ts --execute  # Actually update database
 */

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';

const DB_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');

// Valid concept IDs from code.json observation_concepts
const VALID_CONCEPTS = new Set([
  'how-it-works', 'why-it-exists', 'what-changed',
  'problem-solution', 'gotcha', 'pattern', 'trade-off'
]);

// Type-to-concept inference map (matches parser.ts inferConceptFromType)
const TYPE_TO_CONCEPT: Record<string, string> = {
  'bugfix': 'problem-solution',
  'feature': 'what-changed',
  'refactor': 'what-changed',
  'change': 'what-changed',
  'discovery': 'how-it-works',
  'decision': 'trade-off',
};

interface ObservationRow {
  id: number;
  type: string;
  concepts: string; // JSON array
}

function normalizeConcept(concept: string): string | null {
  const trimmed = concept.trim().toLowerCase();

  // Direct match
  if (VALID_CONCEPTS.has(trimmed)) return trimmed;

  // Colon-prefix normalization
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex > 0) {
    const prefix = trimmed.substring(0, colonIndex).trim();
    if (VALID_CONCEPTS.has(prefix)) return prefix;
  }

  return null; // Invalid
}

function main(): void {
  const dryRun = !process.argv.includes('--execute');

  console.log('='.repeat(60));
  console.log('Claude-Mem Concept Normalization');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN (use --execute to apply)' : 'EXECUTE'}`);
  console.log(`Database: ${DB_PATH}`);
  console.log('');

  const db = new Database(DB_PATH, dryRun ? { readonly: true } : undefined);

  const observations = db.prepare(
    'SELECT id, type, concepts FROM observations WHERE concepts IS NOT NULL'
  ).all() as ObservationRow[];

  // Statistics
  const totalObs = observations.length;
  let alreadyValid = 0;
  let normalized = 0;
  let conceptsDropped = 0;
  let conceptsNormalized = 0; // colon-prefix fixes
  let inferredDefault = 0;

  const updates: Array<{ id: number; newConcepts: string[] }> = [];

  for (const obs of observations) {
    let concepts: string[];
    try {
      const parsed: unknown = JSON.parse(obs.concepts);
      concepts = Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      concepts = [];
    }

    const result: string[] = [];
    let changed = false;

    for (const c of concepts) {
      const norm = normalizeConcept(c);
      if (norm === null) {
        conceptsDropped++;
        changed = true;
      } else if (norm !== c) {
        conceptsNormalized++;
        result.push(norm);
        changed = true;
      } else {
        result.push(norm);
      }
    }

    // Deduplicate
    const unique = [...new Set(result)];
    if (unique.length !== result.length) changed = true;

    // Ensure at least 1 concept
    if (unique.length === 0) {
      const inferred = TYPE_TO_CONCEPT[obs.type] ?? 'what-changed';
      unique.push(inferred);
      inferredDefault++;
      changed = true;
    }

    if (changed) {
      normalized++;
      updates.push({ id: obs.id, newConcepts: unique });
    } else {
      alreadyValid++;
    }
  }

  // Before stats
  const distinctBefore = db.prepare(
    'SELECT COUNT(DISTINCT value) as cnt FROM observations, json_each(observations.concepts)'
  ).get() as { cnt: number };

  // Report
  console.log('BEFORE:');
  console.log(`  Total observations: ${String(totalObs)}`);
  console.log(`  Distinct concept values: ${String(distinctBefore.cnt)}`);
  console.log(`  Already valid: ${String(alreadyValid)}`);
  console.log(`  Need normalization: ${String(normalized)}`);
  console.log('');
  console.log('CHANGES:');
  console.log(`  Concepts dropped (invalid): ${String(conceptsDropped)}`);
  console.log(`  Concepts normalized (colon-prefix): ${String(conceptsNormalized)}`);
  console.log(`  Default inferred (empty after cleanup): ${String(inferredDefault)}`);
  console.log('');

  if (!dryRun && updates.length > 0) {
    const stmt = db.prepare('UPDATE observations SET concepts = ? WHERE id = ?');
    const transaction = db.transaction(() => {
      for (const u of updates) {
        stmt.run(JSON.stringify(u.newConcepts), u.id);
      }
    });
    transaction();

    // After stats
    const distinctAfter = db.prepare(
      'SELECT COUNT(DISTINCT value) as cnt FROM observations, json_each(observations.concepts)'
    ).get() as { cnt: number };

    console.log(`APPLIED: ${String(updates.length)} observations updated.`);
    console.log(`Distinct concept values: ${String(distinctBefore.cnt)} -> ${String(distinctAfter.cnt)}`);
  } else if (dryRun) {
    console.log('DRY RUN complete. Use --execute to apply changes.');
  }

  db.close();
}

main();
