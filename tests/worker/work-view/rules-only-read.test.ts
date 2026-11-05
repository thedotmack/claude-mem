import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStateSource } from '../../../src/services/work-view/data-source.mjs';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe('rules-only reader', () => {
  it('reads only saved rule rows and story, without any activity or evidence SQL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-only-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
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
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('WHERE list_name = ?');
    expect(queries[0]).not.toMatch(/observations|tool_uses|user_prompts|session_summaries|data_version/);
    // An unreadable source must not turn a rules rebuild into an empty successful replacement.
    writeFileSync(join(dir, 'story.json'), '{broken json');
    expect(source.readRules().source.connected).toBe(false);
  });
});
