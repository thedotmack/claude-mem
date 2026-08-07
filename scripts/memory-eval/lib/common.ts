// SPDX-License-Identifier: Apache-2.0

/**
 * Shared plumbing for the memory-eval harness: DB access (production DB is
 * opened READONLY — mutations only ever happen on temp copies), CLI flag
 * parsing, gold-set persistence and report writing.
 */

import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DB_PATH } from '../../../src/shared/paths.js';
import { CHARS_PER_TOKEN_ESTIMATE } from '../../../src/services/context/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EVAL_DIR = join(HERE, '..');
export const GOLD_PATH = join(EVAL_DIR, 'gold.json');
export const JUDGE_CACHE_PATH = join(EVAL_DIR, '.gold-cache.json');
export const REPORTS_DIR = join(EVAL_DIR, 'reports');

export const DAY_MS = 86_400_000;

/** Production DB is NEVER opened writable from this harness. */
export function openReadonlyDb(dbPath: string = DB_PATH): Database {
  const db = new Database(dbPath, { readonly: true });
  db.run('PRAGMA query_only = ON');
  return db;
}

/**
 * Snapshot the DB into a temp file and open it writable. All mutation /
 * erasure tests run against this copy; the production file is untouched.
 * Prefers SQLite's online backup semantics via serialize(); falls back to
 * copying db+wal+shm (SQLite recovers the WAL on open).
 */
export function copyDbToTemp(dbPath: string = DB_PATH): { path: string; db: Database; cleanup: () => void } {
  const tmpPath = join(tmpdir(), `memory-eval-${process.pid}-${Date.now()}.db`);
  const ro = new Database(dbPath, { readonly: true });
  let usedSerialize = false;
  try {
    // bun:sqlite exposes serialize() (online backup of the db to a buffer).
    const anyDb = ro as unknown as { serialize?: () => Uint8Array };
    if (typeof anyDb.serialize === 'function') {
      writeFileSync(tmpPath, anyDb.serialize());
      usedSerialize = true;
    }
  } finally {
    ro.close();
  }
  if (!usedSerialize) {
    copyFileSync(dbPath, tmpPath);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, tmpPath + suffix);
    }
  }
  const db = new Database(tmpPath);
  const cleanup = () => {
    try { db.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(tmpPath + suffix, { force: true }); } catch { /* best effort */ }
    }
  };
  return { path: tmpPath, db, cleanup };
}

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

export interface Flags {
  [name: string]: string | boolean | undefined;
}

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

export function flagInt(flags: Flags, name: string, fallback: number): number {
  const raw = flags[name];
  if (raw === undefined || raw === true) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.floor(v) : fallback;
}

export function flagFloat(flags: Flags, name: string, fallback: number): number {
  const raw = flags[name];
  if (raw === undefined || raw === true) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// Gold set
// ---------------------------------------------------------------------------

export interface GoldItem {
  promptId: number;
  promptText: string;
  promptEpoch: number;
  project: string;
  memorySessionId: string;
  /** Observations from the same memory session as the prompt (linkage gold). */
  sessionLinkedIds: number[];
  /** Candidate pool shown to the judge (session + same-project ±1 day). */
  candidateIds: number[];
  /** Scoring target: judge-confirmed ids when the judge ran, else sessionLinkedIds. */
  relevantIds: number[];
}

export interface GoldSet {
  version: 1;
  builtAt: string;
  dbPath: string;
  judgeUsed: boolean;
  itemCount: number;
  items: GoldItem[];
}

export function saveGold(gold: GoldSet): void {
  writeFileSync(GOLD_PATH, JSON.stringify(gold, null, 2));
}

export function loadGold(): GoldSet {
  if (!existsSync(GOLD_PATH)) {
    throw new Error(`Gold set not found at ${GOLD_PATH} — run \`build-gold\` first`);
  }
  return JSON.parse(readFileSync(GOLD_PATH, 'utf-8')) as GoldSet;
}

// ---------------------------------------------------------------------------
// Cost axis (rule 2): token estimate per injected item
// ---------------------------------------------------------------------------

export interface Textual {
  title?: string | null;
  narrative?: string | null;
  facts?: string | null;
}

/** chars/4 — the same CHARS_PER_TOKEN_ESTIMATE the context header uses. */
export function estimateTokens(item: Textual): number {
  const chars = (item.title?.length ?? 0) + (item.narrative?.length ?? 0) + (item.facts?.length ?? 0);
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export class Report {
  readonly md: string[] = [];
  readonly json: Record<string, unknown> = {};
  readonly notes: string[] = [];

  line(s = ''): void {
    this.md.push(s);
  }

  note(s: string): void {
    this.notes.push(s);
  }

  write(command: string): { mdPath: string; jsonPath: string } {
    mkdirSync(REPORTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const mdPath = join(REPORTS_DIR, `${stamp}-${command}.md`);
    const jsonPath = join(REPORTS_DIR, `${stamp}-${command}.json`);
    const header = [
      `# memory-eval: ${command}`,
      '',
      `- generated: ${new Date().toISOString()}`,
      ...this.notes.map(n => `- NOTE: ${n}`),
      '',
    ];
    writeFileSync(mdPath, header.concat(this.md).join('\n'));
    writeFileSync(jsonPath, JSON.stringify({ command, generatedAt: new Date().toISOString(), notes: this.notes, ...this.json }, null, 2));
    return { mdPath, jsonPath };
  }
}
