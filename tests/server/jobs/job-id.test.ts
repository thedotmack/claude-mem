import { describe, expect, it } from 'bun:test';
import { buildServerJobId } from '../../../src/server/jobs/job-id.js';

const baseParts = {
  kind: 'event' as const,
  team_id: 'team_abc',
  project_id: 'project_xyz',
  source_type: 'agent_event',
  source_id: 'evt_001'
};

describe('buildServerJobId', () => {
  it('produces deterministic IDs across invocations', () => {
    const a = buildServerJobId(baseParts);
    const b = buildServerJobId(baseParts);
    expect(a).toBe(b);
  });

  it('changes the digest when any scope field changes', () => {
    const baseId = buildServerJobId(baseParts);
    const variants = [
      { ...baseParts, team_id: 'team_other' },
      { ...baseParts, project_id: 'project_other' },
      { ...baseParts, source_type: 'observation_reindex' },
      { ...baseParts, source_id: 'evt_002' },
      { ...baseParts, kind: 'reindex' as const }
    ];
    for (const variant of variants) {
      expect(buildServerJobId(variant)).not.toBe(baseId);
    }
  });

  it('emits IDs without colons so BullMQ key separators stay safe', () => {
    const id = buildServerJobId(baseParts);
    expect(id.includes(':')).toBe(false);
  });

  it('uses a kind-prefixed sha256 hex format', () => {
    const id = buildServerJobId(baseParts);
    expect(id).toMatch(/^evt_[0-9a-f]{64}$/);
  });

  it('uses different prefixes per kind', () => {
    const event = buildServerJobId({ ...baseParts, kind: 'event' });
    const batch = buildServerJobId({ ...baseParts, kind: 'event-batch' });
    const summary = buildServerJobId({ ...baseParts, kind: 'summary' });
    const reindex = buildServerJobId({ ...baseParts, kind: 'reindex' });
    expect(event.startsWith('evt_')).toBe(true);
    expect(batch.startsWith('evtb_')).toBe(true);
    expect(summary.startsWith('sum_')).toBe(true);
    expect(reindex.startsWith('rdx_')).toBe(true);
  });
});
