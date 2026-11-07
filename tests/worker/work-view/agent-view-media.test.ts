import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { buildAgentView, readAgentRecords } from '../../../src/services/work-view/agent-view.mjs';
import { reduceWorkState } from '../../../src/services/work-view/data-source.mjs';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const ref = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, label: `image-${n}`, inspection: 'uninspected' });
const manifest = (...ids: number[]) => JSON.stringify({ cmem_media_v1: { version: 1, attachments: ids.map(ref) } });

/**
 * A real migrated database: one conversation with one ask and four observations from that turn. Databases from older
 * releases also carry observations.content_session_id; SessionStore's own schema never adds it (`fresh: true` keeps it out).
 */
function databaseWithImages({ fresh = false } = {}) {
  const database = new Database(':memory:');
  new SessionStore(database);
  const hasContentSession = database.prepare('PRAGMA table_info(observations)').all().some((column: any) => column.name === 'content_session_id');
  if (!fresh && !hasContentSession) database.exec('ALTER TABLE observations ADD COLUMN content_session_id TEXT');
  database.prepare(`INSERT INTO sdk_sessions (id, content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, status)
    VALUES (1, 'content-1', 'memory-1', 'repo', 'claude', 'Build the image gallery', '2026-11-05T11:00:00Z', ?, 'active')`).run(NOW - 3_600_000);
  database.prepare(`INSERT INTO user_prompts (id, session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (10, 1, 'content-1', 1, 'Build the image gallery', '2026-11-05T11:00:00Z', ?)`).run(NOW - 3_600_000);
  const observation = database.prepare(fresh
    ? `INSERT INTO observations (id, memory_session_id, project, prompt_number, type, title, metadata, created_at, created_at_epoch)
    VALUES (?, 'memory-1', 'repo', 1, 'discovery', ?, ?, '2026-11-05T11:30:00Z', ?)`
    : `INSERT INTO observations (id, memory_session_id, content_session_id, project, prompt_number, type, title, metadata, created_at, created_at_epoch)
    VALUES (?, 'memory-1', 'content-1', 'repo', 1, 'discovery', ?, ?, '2026-11-05T11:30:00Z', ?)`);
  observation.run(1, 'Read the first screenshot', manifest(1, 2), NOW - 40 * 60_000);
  observation.run(2, 'Planned the layout', null, NOW - 30 * 60_000);
  // An invalid namespace fails closed: the row renders image-free.
  observation.run(3, 'Recorded a broken manifest', JSON.stringify({ cmem_media_v1: { version: 2, attachments: [] } }), NOW - 20 * 60_000);
  observation.run(4, 'Read two more screenshots', manifest(2, 3, 4, 5), NOW - 10 * 60_000);
  return database;
}

describe('observation images ride the work view snapshot', () => {
  it('attaches validated refs to observation activity and summarizes them on the request, with no raw metadata', () => {
    const database = databaseWithImages();
    const state = reduceWorkState([], { currentProject: 'repo', currentProjectScope: ['repo'] });
    const view = buildAgentView(state, readAgentRecords(database, { workState: state, now: NOW }), { now: NOW });
    const [request] = view.humanRequests;
    expect(view.humanRequests).toHaveLength(1);
    const media = Object.fromEntries(request.activity.map((entry: any) => [entry.id, entry.media]));
    expect(media['observation:1']).toEqual({ version: 1, attachments: [ref(1), ref(2)] });
    expect(media['observation:4']).toEqual({ version: 1, attachments: [ref(2), ref(3), ref(4), ref(5)] });
    expect(request.activity.filter((entry: any) => Object.hasOwn(entry, 'media')).map((entry: any) => entry.id).sort()).toEqual(['observation:1', 'observation:4']);
    // Five distinct images (image-2 is linked twice); the preview is the newest four.
    expect(request.media).toEqual({ count: 5, preview: [ref(2), ref(3), ref(4), ref(5)] });
    // Ids and labels only: neither the column nor its namespace leaves the projection.
    const wire = JSON.stringify(view);
    expect(wire).not.toContain('"metadata"');
    expect(wire).not.toContain('cmem_media_v1');
  });

  it('a freshly migrated database (no observations.content_session_id) still shows its observations and images', () => {
    const database = databaseWithImages({ fresh: true });
    expect(database.prepare('PRAGMA table_info(observations)').all().some((column: any) => column.name === 'content_session_id')).toBe(false);
    const state = reduceWorkState([], { currentProject: 'repo', currentProjectScope: ['repo'] });
    const [request] = buildAgentView(state, readAgentRecords(database, { workState: state, now: NOW }), { now: NOW }).humanRequests;
    expect(request.activity.filter((entry: any) => entry.kind === 'observation')).toHaveLength(4);
    expect(request.media).toEqual({ count: 5, preview: [ref(2), ref(3), ref(4), ref(5)] });
  });

  it('a database without the metadata column keeps its observations and shows no images', () => {
    const database = databaseWithImages();
    database.exec('ALTER TABLE observations DROP COLUMN metadata');
    const state = reduceWorkState([], { currentProject: 'repo', currentProjectScope: ['repo'] });
    const [request] = buildAgentView(state, readAgentRecords(database, { workState: state, now: NOW }), { now: NOW }).humanRequests;
    expect(request.activity.filter((entry: any) => entry.kind === 'observation')).toHaveLength(4);
    expect(request.activity.some((entry: any) => Object.hasOwn(entry, 'media'))).toBe(false);
    expect(Object.hasOwn(request, 'media')).toBe(false);
  });
});
