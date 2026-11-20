import { expect, test } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { buildContentOperation } from '../../../src/services/sync/CanonicalContent.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { buildRules, renderRulesFile, ruleRowFields } from '../../../src/services/work-view/my-rules.mjs';
import { reduceWorkState } from '../../../src/services/work-view/work-state-reduce.mjs';

const NOW = 1793491200000;
const RULE = 'Show the verification result.';

test.each([['equal clocks', 0, 'off'], ['a newer owner decision', 1, 'on']] as const)(
  'saved rules agree across different home projects after sync: %s', (_name, newer, expected) => {
    const a = new SessionStore(':memory:');
    const b = new SessionStore(':memory:');
    try {
      a.setLocalSyncDeviceId('a'); b.setLocalSyncDeviceId('b');
      const write = (store: SessionStore, project: string, status: 'on' | 'off', at: number) => {
        store.appendWorkStateEntry({ project, listName: 'my-rules', createdAtEpoch: at, fields: ruleRowFields({
          ruleId: 'own_shared', scopeTier: 'everywhere', scopeName: 'Everywhere', when: '', then: RULE,
          setBy: 'owner', status, source: 'you', timesSeen: 1, latestAt: null,
          quotes: [], replacedBy: null, replacedAt: null,
        }) });
        const row = store.db.query('SELECT * FROM work_state_entries').get() as any;
        return { seq: '1', ...buildContentOperation({ kind: 'work_state', originDeviceId: project,
          originLocalId: String(row.id), entityRev: row.sync_rev,
          payload: { project, list_name: row.list_name, fields: JSON.parse(row.fields),
            created_at: row.created_at, created_at_epoch: String(row.created_at_epoch) },
        }) };
      };
      const fromA = write(a, 'a', 'on', NOW + newer);
      const fromB = write(b, 'b', 'off', NOW);
      // Each device owns one native row. The other home project's row gets a
      // later local ID on arrival, but it keeps its canonical source order.
      expect(new SyncApply(a.db, { deviceId: 'a' }).applyOps(decodeChanges([fromB]), { epoch: '1' }).applied).toBe(1);
      expect(new SyncApply(b.db, { deviceId: 'b' }).applyOps(decodeChanges([fromA]), { epoch: '1' }).applied).toBe(1);
      const rules = (store: SessionStore, device: string) => buildRules(reduceWorkState(
        store.db.query('SELECT * FROM work_state_entries').all(), { localDeviceId: device },
      ), null).rules;
      const left = rules(a, 'a'), right = rules(b, 'b');
      expect(right).toEqual(left);
      expect(left).toHaveLength(1);
      expect(left[0].status).toBe(expected);
      expect(renderRulesFile(left, NOW)).toEqual(renderRulesFile(right, NOW));
      expect(renderRulesFile(left, NOW).approvedCount).toBe(expected === 'on' ? 1 : 0);
      expect(renderRulesFile(left, NOW).markdown.includes(RULE)).toBe(expected === 'on');
    } finally { a.close(); b.close(); }
  },
);
