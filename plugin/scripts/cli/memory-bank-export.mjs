#!/usr/bin/env bun
// claude-mem memory-bank-export — Cline-Memory-Bank-compatible markdown export.
// Spec: docs/sprint2/07-tdd-plan-v2.md Phase 7.
//
// Cline Memory Bank convention (https://docs.cline.bot/prompting/cline-memory-bank):
//   projectbrief.md   — what we're building, why, top-level scope
//   activeContext.md  — what we're focused on right now
//   systemPatterns.md — architectural decisions, design patterns
//   progress.md       — what's done, what's next
//
// Usage:
//   bun memory-bank-export.mjs --project <name> --out <dir> [--db <path>]

import { parseArgs } from 'util';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { DB_PATH } from '../lib/paths.mjs';

const { values: args } = parseArgs({
  options: {
    project: { type: 'string' },
    out:     { type: 'string' },
    db:      { type: 'string' },
    limit:   { type: 'string', default: '50' },
  },
  strict: true,
});

if (!args.project || !args.out) {
  process.stderr.write('Usage: --project <name> --out <dir> [--db <path>] [--limit N]\n');
  process.exit(2);
}
const dbPath = args.db || DB_PATH;
if (!existsSync(dbPath)) {
  process.stderr.write(`[mb-export] no DB at ${dbPath}\n`);
  process.exit(2);
}
mkdirSync(args.out, { recursive: true });

const db = new Database(dbPath, { readonly: true });
const limit = parseInt(args.limit, 10);

function fetch(type, lim = limit) {
  return db.prepare(
    `SELECT id, type, title, subtitle, narrative, text, created_at
     FROM observations
     WHERE project = ? AND type = ?
     ORDER BY created_at_epoch DESC
     LIMIT ?`
  ).all(args.project, type, lim);
}

function fmt(obs) {
  if (!obs.length) return '_No observations yet._';
  return obs.map(o => {
    const title = o.title || o.subtitle || (o.text || o.narrative || '').slice(0, 80);
    const body = o.narrative || o.text || '';
    const date = (o.created_at || '').slice(0, 10);
    return `### ${title}\n_${date} · obs:${o.id}_\n\n${body}`;
  }).join('\n\n---\n\n');
}

const decisions = fetch('decision');
const features = fetch('feature');
const changes = fetch('change', Math.min(30, limit));
const bugfixes = fetch('bugfix', Math.min(30, limit));
const discoveries = fetch('discovery', Math.min(30, limit));
const refactors = fetch('refactor', Math.min(30, limit));

const projectbrief = `# Project Brief — ${args.project}

> Exported from claude-mem on ${new Date().toISOString()}

## Top features captured
${fmt(features.slice(0, 10))}

## Key decisions
${fmt(decisions.slice(0, 10))}
`;

const activeContext = `# Active Context — ${args.project}

> Most recent ${Math.min(30, limit)} changes + bugfixes + discoveries.

## Recent changes
${fmt(changes)}

## Recent bugfixes
${fmt(bugfixes)}

## Recent discoveries
${fmt(discoveries)}
`;

const systemPatterns = `# System Patterns — ${args.project}

> Decisions + refactors that shape the codebase.

## Architectural decisions
${fmt(decisions)}

## Refactors
${fmt(refactors)}
`;

const progress = `# Progress — ${args.project}

> Snapshot of completed and in-flight work.

## Features
${fmt(features)}

## Changes
${fmt(changes)}
`;

writeFileSync(join(args.out, 'projectbrief.md'), projectbrief);
writeFileSync(join(args.out, 'activeContext.md'), activeContext);
writeFileSync(join(args.out, 'systemPatterns.md'), systemPatterns);
writeFileSync(join(args.out, 'progress.md'), progress);

const stats = {
  project: args.project,
  decisions: decisions.length,
  features: features.length,
  changes: changes.length,
  bugfixes: bugfixes.length,
  discoveries: discoveries.length,
  refactors: refactors.length,
  out: args.out,
};
process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
db.close();
