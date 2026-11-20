import { describe, expect, it } from 'bun:test';
import type { Statement } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

function seed(store: SessionStore): void {
  for (let i = 0; i < 40; i++) {
    const id = store.createSDKSession(`catalog-${i}`, i % 3 === 0 ? 'other' : i % 2 === 0 ? 'Repo' : 'repo',
      'prompt', `title ${i}`, i % 2 === 0 ? 'claude' : 'codex');
    store.db.prepare('UPDATE sdk_sessions SET started_at_epoch = ? WHERE id = ?').run(Math.floor(i / 4), id);
    store.saveUserPrompt(`catalog-${i}`, 1, `saved ${i}`, id);
  }
}

describe('project session catalog recency', () => {
  for (const platformSource of [undefined, 'codex']) {
    it(`reads the actual catalog query in index order (${platformSource ?? 'all platforms'})`, () => {
      const store = new SessionStore(':memory:');
      try {
        seed(store);
        const prepare = store.db.prepare;
        const statements: Statement[] = [];
        store.db.prepare = ((...args: Parameters<typeof prepare>) => {
          const statement = prepare.apply(store.db, args);
          statements.push(statement);
          return statement;
        }) as typeof prepare;
        try {
          const page = store.getSessionCatalog({ project: 'REPO', platformSource, limit: 5, offset: 3 });
          expect(page.sessions).toHaveLength(5);
          expect(page.hasMore).toBe(true);
        } finally {
          store.db.prepare = prepare;
        }
        expect(statements).toHaveLength(1);
        // SQLite expands the exact bindings from the real read; the assertion
        // does not maintain a separate copy of the catalog's SQL or predicates.
        const plan = (store.db.query(`EXPLAIN QUERY PLAN ${statements[0].toString()}`).all() as Array<{ detail: string }>)
          .map(row => row.detail);
        expect(plan.some(detail => detail.includes('USE TEMP B-TREE'))).toBe(false);
        expect(plan.some(detail => /SEARCH s USING INDEX.*\(project=\?\)/.test(detail))).toBe(true);
      } finally {
        store.close();
      }
    });
  }

  it('preserves mixed-case project identity, tied ordering, page boundaries and item counts', () => {
    const store = new SessionStore(':memory:');
    try {
      seed(store);
      const ids = Array.from({ length: 40 }, (_, i) => i).filter(i => i % 3 !== 0).reverse();
      const pages = [];
      for (let offset = 0; offset < ids.length; offset += 5) {
        const page = store.getSessionCatalog({ project: 'REPO', limit: 5, offset });
        expect(page.hasMore).toBe(offset + 5 < ids.length);
        pages.push(...page.sessions);
      }
      expect(pages.map(row => row.content_session_id)).toEqual(ids.map(i => `catalog-${i}`));
      expect(pages.map(row => row.project)).toEqual(ids.map(i => i % 2 === 0 ? 'Repo' : 'repo'));
      expect(pages.every(row => row.item_count === 1)).toBe(true);
      expect(pages.map(row => row.custom_title)).toEqual(ids.map(i => `title ${i}`));
      expect(store.getSessionCatalog({ project: 'REPO', platformSource: 'codex' }).sessions
        .map(row => row.content_session_id)).toEqual(ids.filter(i => i % 2 !== 0).map(i => `catalog-${i}`));
      expect(store.getSessionCatalog({ project: 'REPO', offset: ids.length })).toEqual({ sessions: [], hasMore: false });
      expect(store.getSessionCatalog({ project: 'Repo ' }).sessions).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('reflects project moves, timestamp edits and deletions in the next page', () => {
    const store = new SessionStore(':memory:');
    try {
      seed(store);
      store.db.prepare('UPDATE sdk_sessions SET project = ?, started_at_epoch = ? WHERE content_session_id = ?')
        .run('REPO', 100, 'catalog-0');
      expect(store.getSessionCatalog({ project: 'repo', limit: 1 }).sessions[0].content_session_id).toBe('catalog-0');
      store.db.prepare('DELETE FROM sdk_sessions WHERE content_session_id = ?').run('catalog-0');
      expect(store.getSessionCatalog({ project: 'repo', limit: 1 }).sessions[0].content_session_id).toBe('catalog-38');
      store.db.prepare('UPDATE sdk_sessions SET project = ? WHERE content_session_id = ?').run('moved', 'catalog-38');
      expect(store.getSessionCatalog({ project: 'repo', limit: 1 }).sessions[0].content_session_id).toBe('catalog-37');
    } finally {
      store.close();
    }
  });

  it('adds the ordering index when reopening an existing database without changing its rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-recency-'));
    const path = join(dir, 'memory.db');
    let store = new SessionStore(path);
    try {
      seed(store);
      const expected = store.getSessionCatalog();
      store.db.run('DROP INDEX IF EXISTS idx_sdk_sessions_project_nocase_recent');
      store.close();
      store = new SessionStore(path);
      expect(store.db.query("SELECT name FROM sqlite_master WHERE name = 'idx_sdk_sessions_project_nocase_recent'").get())
        .toEqual({ name: 'idx_sdk_sessions_project_nocase_recent' });
      expect(store.getSessionCatalog()).toEqual(expected);
      store.close();
      store = new SessionStore(path);
      expect(store.getSessionCatalog()).toEqual(expected);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
