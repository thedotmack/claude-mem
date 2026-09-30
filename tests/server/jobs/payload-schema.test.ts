// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  ServerGenerationJobPayloadSchema,
  ServerGenerationJobPayloadValidationError,
  assertServerGenerationJobPayload,
} from '../../../src/server/jobs/types.js';

// Phase 11 — schema validation at the queue boundary. Every job payload must
// carry team_id, project_id, generation_job_id, source_adapter, and the
// (nullable) actor/api_key identity fields. Unit tests confirm that omitting
// any required field rejects the payload synchronously.

describe('ServerGenerationJobPayloadSchema', () => {
  const validEvent = {
    kind: 'event' as const,
    team_id: 'team_1',
    project_id: 'project_1',
    source_type: 'agent_event' as const,
    source_id: 'evt_1',
    generation_job_id: 'gen_1',
    agent_event_id: 'evt_1',
    api_key_id: 'apk_1',
    actor_id: 'system:test',
    source_adapter: 'api',
  };

  it('accepts a fully populated event payload', () => {
    const result = ServerGenerationJobPayloadSchema.safeParse(validEvent);
    expect(result.success).toBe(true);
  });

  it('rejects payload missing team_id', () => {
    const { team_id, ...rest } = validEvent;
    const result = ServerGenerationJobPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map(i => i.path.join('.')).join(',');
      expect(message).toContain('team_id');
    }
  });

  it('rejects payload missing project_id', () => {
    const { project_id, ...rest } = validEvent;
    const result = ServerGenerationJobPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects payload missing generation_job_id', () => {
    const { generation_job_id, ...rest } = validEvent;
    const result = ServerGenerationJobPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects payload missing source_adapter', () => {
    const { source_adapter, ...rest } = validEvent;
    const result = ServerGenerationJobPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('requires the api_key_id field to be present (null is allowed)', () => {
    const { api_key_id, ...withoutKey } = validEvent;
    const result = ServerGenerationJobPayloadSchema.safeParse(withoutKey);
    expect(result.success).toBe(false);

    const withNullKey = { ...validEvent, api_key_id: null };
    expect(ServerGenerationJobPayloadSchema.safeParse(withNullKey).success).toBe(true);
  });

  it('requires the actor_id field to be present (null is allowed)', () => {
    const { actor_id, ...withoutActor } = validEvent;
    const result = ServerGenerationJobPayloadSchema.safeParse(withoutActor);
    expect(result.success).toBe(false);

    const withNullActor = { ...validEvent, actor_id: null };
    expect(ServerGenerationJobPayloadSchema.safeParse(withNullActor).success).toBe(true);
  });

  it('accepts a summary payload with server_session_id', () => {
    const summary = {
      kind: 'summary' as const,
      team_id: 't1',
      project_id: 'p1',
      source_type: 'session_summary' as const,
      source_id: 'ses_1',
      generation_job_id: 'gen_2',
      server_session_id: 'ses_1',
      api_key_id: null,
      actor_id: null,
      source_adapter: 'api',
    };
    expect(ServerGenerationJobPayloadSchema.safeParse(summary).success).toBe(true);
  });

  it('rejects summary payload missing server_session_id', () => {
    const summary = {
      kind: 'summary' as const,
      team_id: 't1',
      project_id: 'p1',
      source_type: 'session_summary' as const,
      source_id: 'ses_1',
      generation_job_id: 'gen_2',
      api_key_id: null,
      actor_id: null,
      source_adapter: 'api',
    };
    expect(ServerGenerationJobPayloadSchema.safeParse(summary).success).toBe(false);
  });

  it('assertServerGenerationJobPayload throws ServerGenerationJobPayloadValidationError on bad input', () => {
    expect(() => assertServerGenerationJobPayload({ kind: 'event' })).toThrow(
      ServerGenerationJobPayloadValidationError,
    );
  });

  it('assertServerGenerationJobPayload returns typed payload on success', () => {
    const validated = assertServerGenerationJobPayload(validEvent);
    expect(validated.kind).toBe('event');
    expect(validated.team_id).toBe('team_1');
    expect(validated.source_adapter).toBe('api');
  });
});
