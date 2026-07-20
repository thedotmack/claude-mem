import {
  buildContentOperation,
  type CanonicalHubChange,
} from '../../../src/services/sync/CanonicalContent.js';

export interface TestHubChange extends CanonicalHubChange {
  seq: string;
  server_ts: string;
}

export function observationChange(
  seq: number,
  originLocalId: string,
  originDeviceId = 'device-a',
  payloadOverrides: Record<string, unknown> = {},
): TestHubChange {
  const createdAtEpoch = 1_751_328_000_000 + seq;
  const operation = buildContentOperation({
    kind: 'observation',
    originDeviceId,
    originLocalId,
    entityRev: '1',
    payload: {
      memory_session_id: 'mem-remote-1',
      project: 'proj-remote',
      text: null,
      type: 'discovery',
      title: `obs ${originLocalId}`,
      subtitle: null,
      facts: ['remote fact'],
      narrative: 'remote narrative',
      concepts: null,
      files_read: null,
      files_modified: null,
      prompt_number: '1',
      discovery_tokens: '0',
      content_hash: `hash-${originLocalId}`,
      generated_by_model: null,
      agent_type: null,
      agent_id: null,
      metadata: null,
      merged_into_project: null,
      created_at: new Date(createdAtEpoch).toISOString(),
      created_at_epoch: String(createdAtEpoch),
      ...payloadOverrides,
    },
  });
  return {
    ...operation,
    seq: String(seq),
    server_ts: String(createdAtEpoch),
  };
}
