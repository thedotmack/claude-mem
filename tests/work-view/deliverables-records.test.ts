import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentView, readAgentRecords } from '../../src/services/work-view/agent-view.mjs';
import { reduceWorkState } from '../../src/services/work-view/data-source.mjs';

const DAY = 86400000, NOW = 100 * DAY;

/** The tables the read path touches, with the columns real databases have, plus the deliverables table the Stop hook fills. */
function database() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, project TEXT, user_prompt TEXT, started_at_epoch INTEGER, cwd TEXT, custom_title TEXT, status TEXT, completed_at_epoch INTEGER);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, tool_name TEXT, tool_input TEXT, tool_response TEXT, cwd TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, type TEXT, title TEXT, subtitle TEXT, files_modified TEXT, created_at_epoch INTEGER);
    CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);
    CREATE TABLE deliverables (id INTEGER PRIMARY KEY, project TEXT, content_session_id TEXT, platform_source TEXT, title TEXT, kind TEXT, source_path TEXT, bucket_path TEXT, created_at_epoch INTEGER);`);
  db.prepare('INSERT INTO sdk_sessions (id, platform_source, content_session_id, memory_session_id, project, user_prompt, started_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)').run(1, 'claude', 'c-1', 'm1', 'repo', 'Make me a launch report', NOW - DAY);
  db.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)').run(1, 1, 'Make me a launch report', NOW - DAY);
  return db;
}

describe('deliverables through the real read path', () => {
  it('a bucket copy the Stop hook recorded reaches the request card as an openable deliverable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-deliverables-read-'));
    const bucketPath = join(dir, 'launch-report-e3003e69.html');
    writeFileSync(bucketPath, '<h1>Launch report</h1>');
    const db = database();
    db.prepare('INSERT INTO deliverables (project, content_session_id, platform_source, title, kind, source_path, bucket_path, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('repo', 'c-1', 'claude', 'Launch report', 'page', '/w/.scratch/launch-report.html', bucketPath, NOW - DAY + 60_000);
    // The observer also saw the file being written where it was made; the bucket copy replaces that record.
    db.prepare('INSERT INTO observations (memory_session_id, type, title, files_modified, created_at_epoch) VALUES (?, ?, ?, ?, ?)')
      .run('m1', 'change', 'Wrote the report', JSON.stringify(['/w/.scratch/launch-report.html']), NOW - DAY + 30_000);
    const state = reduceWorkState([], { currentProject: 'repo' });

    const view = buildAgentView(state, readAgentRecords(db, { workState: state, now: NOW }), { now: NOW });

    expect(view.humanRequests).toHaveLength(1);
    expect(view.humanRequests[0].workProduct.map((product: any) => [product.kind, product.title, product.url, product.available, product.deliverable])).toEqual([
      ['page', 'Launch report', '/api/deliverables/1/launch-report-e3003e69.html', true, true],
    ]);
    rmSync(dir, { recursive: true, force: true });
    db.close();
  });

  it('a database from before the table existed reads as having no deliverables', () => {
    const db = database();
    db.exec('DROP TABLE deliverables');
    const state = reduceWorkState([], { currentProject: 'repo' });
    const view = buildAgentView(state, readAgentRecords(db, { workState: state, now: NOW }), { now: NOW });
    expect(view.humanRequests[0].workProduct).toEqual([]);
    db.close();
  });
});
