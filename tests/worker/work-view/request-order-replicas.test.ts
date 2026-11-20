import { expect, test } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { buildContentOperation } from '../../../src/services/sync/CanonicalContent.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { buildHumanRequests } from '../../../src/services/work-view/request-projection.mjs';
import { sharedReviewDescriptor } from '../../../src/services/work-view/shared-reviews.mjs';

const NOW = 1793491200000;
const key = (name: string) => JSON.stringify(['conversation', 'claude', name]);

test.each([['original ask', false], ['scope updates', true]] as const)('grouped requests keep the same reviewed evidence after reordered replication: %s', (_name, earlier) => {
  const a = new SessionStore(':memory:');
  const b = new SessionStore(':memory:');
  try {
    a.setLocalSyncDeviceId('a'); b.setLocalSyncDeviceId('b');
    for (const [name, text] of [['alpha', 'Build the shared viewer.'], ['beta', 'Polish the shared viewer.'], ['gamma', 'Test the shared viewer.']]) {
      const session = a.createSDKSession(name, 'repo', text, undefined, 'claude');
      a.updateMemorySessionId(session, `memory-${name}`);
      a.saveUserPrompt(name, 1, text, session);
    }
    a.db.query('UPDATE user_prompts SET created_at_epoch = ?, created_at = ?').run(NOW, new Date(NOW).toISOString());
    if (earlier) a.db.query("UPDATE user_prompts SET created_at_epoch = ?, created_at = ? WHERE content_session_id = 'gamma'")
      .run(NOW - 1, new Date(NOW - 1).toISOString());
    const padding = b.createSDKSession('padding', 'other', 'Unrelated work.', undefined, 'claude');
    b.saveUserPrompt('padding', 1, 'Unrelated work.', padding);

    // The canonical stream may arrive in a different order from the native
    // inserts. Local row IDs must not decide the shared review's evidence.
    const rows = a.db.query(`SELECT p.*, s.memory_session_id, s.platform_source, s.project
      FROM user_prompts p JOIN sdk_sessions s ON s.id = p.session_db_id ORDER BY p.id DESC`).all() as any[];
    new SyncApply(b.db, { deviceId: 'b' }).applyOps(decodeChanges(rows.map((row, i) => ({
      seq: String(i + 1), ...buildContentOperation({ kind: 'prompt', originDeviceId: 'a',
        originLocalId: String(row.id), entityRev: row.sync_rev,
        payload: Object.fromEntries(['content_session_id', 'memory_session_id', 'platform_source', 'project',
          'prompt_number', 'prompt_text', 'created_at', 'created_at_epoch'].map(field => [field,
          ['prompt_number', 'created_at_epoch'].includes(field) ? String(row[field]) : row[field]])),
      }),
    }))), { epoch: '1' });
    const ledger = { groups: { groups: { shared: { anchor: key('alpha'), projectRoot: 'repo', title: 'Shared viewer' } },
      conversations: Object.fromEntries(['alpha', 'beta', 'gamma'].map(name => [key(name), 'shared'])), ignored: {} } };
    const project = (store: SessionStore) => buildHumanRequests({ agents: [] }, {
      sessions: store.db.query("SELECT * FROM sdk_sessions WHERE project = 'repo' ORDER BY id").all(),
      prompts: store.db.query('SELECT * FROM user_prompts ORDER BY id').all(),
    }, { ledger }).humanRequests[0];
    const left = project(a), right = project(b);
    const leftReview = sharedReviewDescriptor(a.db, left, { deviceId: 'a' });
    const rightReview = sharedReviewDescriptor(b.db, right, { deviceId: 'b' });

    expect(leftReview.complete).toBe(true);
    expect(rightReview).toEqual(leftReview);
    expect(right.original.text).toBe(earlier ? 'Test the shared viewer.' : 'Build the shared viewer.');
    expect(right.scopeUpdates.map((row: any) => row.text)).toEqual(left.scopeUpdates.map((row: any) => row.text));
  } finally { a.close(); b.close(); }
});
