// SPDX-License-Identifier: Apache-2.0
//
// #2560 — platform_source threading + idempotent Postgres migration.

import { describe, expect, it } from 'bun:test';
import { CreateAgentEventSchema, AgentEventSchema } from '../../src/core/schemas/agent-event.js';

describe('agent-event platformSource threading (#2560)', () => {
  it('CreateAgentEventSchema preserves platformSource when provided', () => {
    const parsed = CreateAgentEventSchema.parse({
      projectId: 'proj-1',
      sourceType: 'api',
      eventType: 'tool_use',
      platformSource: 'opencode',
      occurredAtEpoch: 1,
    });
    expect(parsed.platformSource).toBe('opencode');
  });

  it('defaults platformSource to null when omitted (back-compat)', () => {
    const parsed = CreateAgentEventSchema.parse({
      projectId: 'proj-1',
      sourceType: 'hook',
      eventType: 'tool_use',
      occurredAtEpoch: 1,
    });
    expect(parsed.platformSource).toBeNull();
  });

  it('full AgentEventSchema round-trips platformSource', () => {
    const parsed = AgentEventSchema.parse({
      id: 'evt-1',
      projectId: 'proj-1',
      sourceType: 'server',
      eventType: 'tool_use',
      platformSource: 'claude-code',
      occurredAtEpoch: 1,
      createdAtEpoch: 2,
    });
    expect(parsed.platformSource).toBe('claude-code');
  });
});
