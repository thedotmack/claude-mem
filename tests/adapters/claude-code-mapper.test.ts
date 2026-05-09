import { describe, expect, it } from 'bun:test';
import {
  mapClaudeCodeObservationToAgentEvent,
  mapClaudeCodeSessionInitToAgentEvent,
} from '../../src/adapters/claude-code/mapper.js';
import { genericRestEventExamples } from '../../src/adapters/generic-rest/examples.js';

describe('claude-code adapter mapper', () => {
  it('maps hook observation payloads to agent events without dropping legacy fields', () => {
    const event = mapClaudeCodeObservationToAgentEvent('project-1', {
      contentSessionId: 'content-1',
      platformSource: 'Claude Code',
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
      tool_response: { content: 'hello' },
      cwd: '/repo',
      agentId: 'agent-1',
      agentType: 'subagent',
      tool_use_id: 'tool-1',
    }, 123);

    expect(event).toMatchObject({
      projectId: 'project-1',
      sourceType: 'hook',
      eventType: 'observation.created',
      contentSessionId: 'content-1',
      occurredAtEpoch: 123,
    });
    expect(event.payload).toMatchObject({
      platformSource: 'claude',
      tool_name: 'Read',
      cwd: '/repo',
      agentId: 'agent-1',
      agentType: 'subagent',
      tool_use_id: 'tool-1',
      toolUseId: 'tool-1',
    });
  });

  it('maps session init payloads using normalized platform source', () => {
    const event = mapClaudeCodeSessionInitToAgentEvent('project-1', {
      contentSessionId: 'content-1',
      platformSource: 'codex transcript',
    }, 456);

    expect(event.eventType).toBe('session.init');
    expect(event.payload).toMatchObject({ platformSource: 'codex' });
  });

  it('ships generic REST examples for non-Claude agents', () => {
    expect(genericRestEventExamples.codexObservation.payload.platformSource).toBe('codex');
    expect(genericRestEventExamples.opencodeObservation.payload.platformSource).toBe('opencode');
    expect(genericRestEventExamples.customMemory.kind).toBe('manual');
  });
});
