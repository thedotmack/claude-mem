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
      { ...baseParts, kind: 'summary' as const }
    ];
    for (const variant of variants) {
      expect(buildServerJobId(variant)).not.toBe(baseId);
    }
  });

  it('uses a kind-prefixed sha256 hex format', () => {
    const id = buildServerJobId(baseParts);
    expect(id).toMatch(/^evt_[0-9a-f]{64}$/);
    expect(buildServerJobId({ ...baseParts, kind: 'summary' })).toMatch(/^sum_[0-9a-f]{64}$/);
  });

});
