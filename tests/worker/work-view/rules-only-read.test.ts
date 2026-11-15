import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { removeTempDir } from '../../helpers/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { WorkStateSource } from '../../../src/services/work-view/data-source.mjs';
import { publishSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { isSharedProjectionValue } from '../../../src/services/work-view/shared-projection.mjs';

const cleanups: Array<() => void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('rules-only reader', () => {
  it('reads only saved rule rows and story, without any activity or evidence SQL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-only-'));
    cleanups.push(() => removeTempDir(dir));
    const databasePath = join(dir, 'source.db');
    const writer = new Database(databasePath);
    cleanups.push(() => writer.close());
    writer.exec('CREATE TABLE work_state_entries(id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)');
    const insert = writer.prepare('INSERT INTO work_state_entries VALUES(?,?,?,?,?)');
    insert.run(1, 'home', 'my-rules', JSON.stringify({ task: 'Rule: own_a', rule_id: 'own_a', then: 'Keep this decision.', status: 'on', set_by: 'owner' }), 1000);
    insert.run(2, 'home', 'unrelated', '{broken json', 2000);
    writeFileSync(join(dir, 'story.json'), JSON.stringify({ preferences: [{ preference: 'A learned suggestion.' }] }));
    writeFileSync(join(dir, 'request-groups.json'), '{broken json');
    const source = new WorkStateSource({ databasePath, ledgerDir: dir });
    cleanups.push(() => source.close());
    const database = (source as any).openDatabase();
    const prepare = database.prepare.bind(database);
    const queries: string[] = [];
    database.prepare = (sql: string) => { queries.push(sql); return prepare(sql); };
    const result = source.readRules();
    expect(result.source.connected).toBe(true);
    expect(result.rules.map(rule => rule.then)).toEqual(['A learned suggestion.', 'Keep this decision.']);
    expect(queries[0]).toContain('WHERE list_name = ?');
    // Besides the rules query: the shared-row scan behind the row cache, in its own read transaction.
    const others = queries.slice(1).filter(sql => !/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/.test(sql));
    expect(others).toHaveLength(1);
    expect(others[0]).toContain('__my_work_v');
    for (const sql of queries) expect(sql).not.toMatch(/observations|tool_uses|user_prompts|session_summaries|data_version/);
    // An unreadable source must not turn a rules rebuild into an empty successful replacement.
    writeFileSync(join(dir, 'story.json'), '{broken json');
    expect(source.readRules().source.connected).toBe(false);
  });

  it('feeds its reducer only the rule rows and reads shared records through the row cache', () => {
    // Shared My Work rows are most of work_state_entries on a busy replica (24,424 of 36,407 rows, 50 MB, on the
    // cloud viewer's account). A rules request must not load them all into memory again.
    const dir = mkdtempSync(join(tmpdir(), 'rules-only-shared-'));
    cleanups.push(() => removeTempDir(dir));
    const databasePath = join(dir, 'source.db');
    const owner = new SessionStore(databasePath);
    cleanups.push(() => owner.close());
    owner.setLocalSyncDeviceId('a');
    owner.db.prepare("INSERT INTO work_state_entries(project,list_name,fields,created_at,created_at_epoch) VALUES ('home','my-rules',?,'2026-11-01T00:00:00Z',1000)")
      .run(JSON.stringify({ task: 'Rule: own_a', rule_id: 'own_a', then: 'Keep this decision.', status: 'on', set_by: 'owner' }));
    // Twenty revisions of the shared story: sixty shared rows, of which only the last revision is current.
    for (let revision = 1; revision <= 20; revision++) {
      publishSharedRecords(owner.db, { deviceId: 'a', project: 'repo', validateValue: isSharedProjectionValue, updates: [{ kind: 'story', key: 'current',
        value: { narrative: `Revision ${revision}.`, preferences: [{ preference: 'A shared suggestion.', kind: 'directive', supportCount: revision, quotes: [] }] } }] });
    }
    const source = new WorkStateSource({ databasePath, ledgerDir: dir, localDeviceId: 'a' });
    cleanups.push(() => source.close());
    const database = (source as any).openDatabase();
    const prepare = database.prepare.bind(database);
    const listedNames: string[] = [];
    database.prepare = (sql: string) => {
      const statement = prepare(sql);
      const all = statement.all.bind(statement);
      statement.all = (...params: unknown[]) => { const rows = all(...params); listedNames.push(...rows.map((row: any) => String(row.list_name))); return rows; };
      return statement;
    };
    for (let request = 0; request < 2; request++) {
      const result = source.readRules();
      expect(result.source.connected).toBe(true);
      expect(result.rules.map((rule: any) => rule.then).sort()).toEqual(['A shared suggestion.', 'Keep this decision.']);
    }
    expect(listedNames).toEqual(['my-rules', 'my-rules']);
  });
});
