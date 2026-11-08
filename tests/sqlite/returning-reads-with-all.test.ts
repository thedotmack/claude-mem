import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// System SQLite 3.37 (macOS 12, used by bun:sqlite there) throws
// "SQL logic error" when a statement with RETURNING is read with `.get()`
// (#5497). Every bun:sqlite RETURNING statement must be read with `.all()`.
// Postgres code (`pool.query`) is not affected and is skipped.
const SRC = join(import.meta.dir, '..', '..', 'src');
const POSTGRES_DIRS = [join(SRC, 'storage', 'postgres'), join(SRC, 'server')];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function returningGetSites(text: string): string[] {
  const sites: string[] = [];
  // Inline SQL: `... RETURNING id\n  `).get(
  for (const match of text.matchAll(/RETURNING[^`]*`\s*\)\s*\.get\(/g)) sites.push(match[0].slice(0, 40));
  // Named SQL constants: const X = `... RETURNING ...`; later query(X).get( / prepare(X).get(
  for (const match of text.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*`([^`]*)`/g)) {
    if (!/\bRETURNING\b/.test(match[2])) continue;
    const use = new RegExp(`(?:query|prepare)\\(\\s*${match[1]}\\s*\\)\\s*\\.get\\(`);
    if (use.test(text)) sites.push(`${match[1]}.get(`);
  }
  return sites;
}

describe('bun:sqlite RETURNING statements', () => {
  it('are read with .all(), never .get() (SQLite 3.37 throws on .get)', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => !POSTGRES_DIRS.some((dir) => path.startsWith(dir)))
      .flatMap((path) => returningGetSites(readFileSync(path, 'utf8')).map((site) => `${relative(SRC, path)}: ${site}`));
    expect(offenders).toEqual([]);
  });

  it('the scanner catches both inline and named-constant .get() reads', () => {
    expect(returningGetSites('db.prepare(`INSERT INTO t VALUES (?) RETURNING id\n`).get(1)')).toHaveLength(1);
    expect(returningGetSites('const CLAIM_SQL = `INSERT INTO t VALUES (?) RETURNING 1`;\ndb.query(CLAIM_SQL).get(1)')).toHaveLength(1);
    expect(returningGetSites('db.prepare(`INSERT INTO t VALUES (?) RETURNING id\n`).all(1)[0]')).toHaveLength(0);
  });
});
