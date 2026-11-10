import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MediaStore, mediaEventKey, mediaReplayKey } from '../../src/services/media/store.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import type { MediaProvenance } from '../../src/shared/media-contract.js';

const SCRATCH = join(import.meta.dir, '../../.scratch');
const TARGET = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
let directory: string;
let db: Database;
let sessions: SessionStore;
let store: MediaStore;

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  directory = realpathSync(mkdtempSync(join(SCRATCH, 'media-cleanup-backlog-')));
  db = new Database(':memory:');
  sessions = new SessionStore(db);
  store = new MediaStore(db, directory);
  mkdirSync(join(store.root, '.tmp'), { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

// The durable state left by a process that died after staging a variant but
// before publishing its directory and committing the ready state.
function recordInterruptedCapture(id: string, sessionDbId: number, leaseUntil: number): void {
  const provenance: MediaProvenance = {
    version: 1,
    attachment_id: id,
    platform: 'claude-code',
    event_identity: { kind: 'platform_event', id: id.replaceAll('-', '').padEnd(64, '0') },
    source_shape: 'anthropic_base64',
    source_pointer: '/content/0',
    source_index: 0,
    source_sha256: 'a'.repeat(64),
    recipe: 'screenshot-v1',
  };
  const event = mediaEventKey(provenance.platform, provenance.event_identity);
  db.prepare(`INSERT INTO media_events(event_key,session_db_id,platform,event_identity,created_at)
    VALUES(?,?,?,?,1)`).run(event, sessionDbId, provenance.platform, JSON.stringify(provenance.event_identity));
  db.prepare(`INSERT INTO media_attachments(id,replay_key,provenance,recipe,state,lease_until,created_at)
    VALUES(?,?,?,'screenshot-v1','converting',?,1)`)
    .run(id, mediaReplayKey(provenance), JSON.stringify(provenance), leaseUntil);
  db.prepare(`INSERT INTO media_event_refs(event_key,attachment_id,label) VALUES(?,?,'event1_image1')`).run(event, id);
}

function stage(id: string, attempt: number): void {
  const target = join(store.root, '.tmp', id + '-' + attempt.toString().padStart(4, '0'));
  mkdirSync(target);
  writeFileSync(join(target, 'viewer.webp'), 'interrupted image bytes');
}

function stages(id: string): string[] {
  return readdirSync(join(store.root, '.tmp')).filter(name => name.startsWith(id + '-'));
}

describe('durable cleanup with a populated staging directory', () => {
  for (const reason of ['expired conversion', 'deleted session'] as const) {
    it(`removes files beyond the first 128 directory entries after ${reason}`, () => {
      const background = sessions.createSDKSession('background', 'project', '');
      const targetSession = sessions.createSDKSession('target', 'project', '');
      const ids = Array.from({ length: 129 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`);
      for (const id of ids) stage(id, 0);
      const entries = readdirSync(join(store.root, '.tmp'));
      // Filesystems need not enumerate alphabetically. Pick the last actual
      // entry so the regression does not depend on directory ordering.
      const target = entries[128].slice(0, 36);
      for (const id of ids) {
        recordInterruptedCapture(id, id === target ? targetSession : background,
          id === target && reason === 'expired conversion' ? 1 : Number.MAX_SAFE_INTEGER);
      }
      if (reason === 'deleted session') db.prepare('DELETE FROM sdk_sessions WHERE id=?').run(targetSession);

      store.reconcile(2);

      expect(stages(target)).toEqual([]);
      expect(readdirSync(join(store.root, '.tmp'))).toHaveLength(128);
      expect(db.prepare('SELECT 1 FROM media_cleanup_jobs WHERE attachment_id=?').get(target)).toBeNull();
      expect(db.prepare(`SELECT COUNT(*) AS count FROM media_attachments WHERE state='converting'`).get()).toEqual({ count: 128 });
    });
  }

  it('keeps a cleanup receipt until all of one attachment\'s staging files have been removed', () => {
    const session = sessions.createSDKSession('multiple-interruptions', 'project', '');
    recordInterruptedCapture(TARGET, session, 1);
    for (let i = 0; i < 130; i++) stage(TARGET, i);

    store.reconcile(2);

    expect(stages(TARGET)).toHaveLength(2);
    expect(db.prepare('SELECT attempts,last_error FROM media_cleanup_jobs WHERE attachment_id=?').get(TARGET))
      .toEqual({ attempts: 0, last_error: null });

    store.reconcile(3);

    expect(stages(TARGET)).toEqual([]);
    expect(db.prepare('SELECT 1 FROM media_cleanup_jobs WHERE attachment_id=?').get(TARGET)).toBeNull();
  });
});
