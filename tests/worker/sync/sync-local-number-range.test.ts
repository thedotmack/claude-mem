import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { observationChange } from './content-v2-helpers.js';

describe('sync wire values beyond the local numeric range', () => {
  for (const field of ['created_at_epoch', 'discovery_tokens', 'prompt_number']) {
    it(`sets aside an unrepresentable ${field} without dropping neighbouring changes`, () => {
      const bad = observationChange(2, '12', 'device-a', { [field]: '9007199254740992' });
      const ops = decodeChanges([observationChange(1, '11'), bad, observationChange(3, '13')]);
      assert.deepEqual(ops.map(op => op.seq), ['1', '2', '3']);
      assert.ok(!('undecodable' in ops[0]));
      assert.ok(!('undecodable' in ops[2]));
      assert.ok('undecodable' in ops[1]);
      assert.match(ops[1].undecodable, /exceeds the local SQLite safe-integer range/);
      assert.equal(ops[1].raw, JSON.stringify(bad));
    });
  }

  it('preserves the largest exactly representable local integer', () => {
    const [op] = decodeChanges([observationChange(1, '11', 'device-a', { discovery_tokens: '9007199254740991' })]);
    assert.ok(!('undecodable' in op));
    assert.equal(JSON.parse(op.body).discovery_tokens, Number.MAX_SAFE_INTEGER);
  });

  it('still rejects a page whose offending change has no valid sequence', () => {
    const bad = observationChange(2, '12', 'device-a', { prompt_number: '9007199254740992' });
    assert.throws(() => decodeChanges([{ ...bad, seq: 'not-a-sequence' }]), /decimal values/);
  });
});
