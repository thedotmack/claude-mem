// SPDX-License-Identifier: Apache-2.0

export const genericRestEventExamples = {
  codexObservation: {
    projectId: 'project-id',
    sourceType: 'api',
    eventType: 'observation.created',
    contentSessionId: 'codex-session-id',
    payload: {
      platformSource: 'codex',
      tool_name: 'shell',
      cwd: '/workspace/project',
      agentId: 'codex-agent-id',
      agentType: 'codex',
      toolUseId: 'tool-call-id',
      tool_input: { command: 'bun test' },
      tool_response: { exitCode: 0 },
    },
    occurredAtEpoch: 1760000000000,
  },
  opencodeObservation: {
    projectId: 'project-id',
    sourceType: 'api',
    eventType: 'observation.created',
    contentSessionId: 'opencode-session-id',
    payload: {
      platformSource: 'opencode',
      tool_name: 'edit',
      cwd: '/workspace/project',
      toolUseId: 'tool-call-id',
    },
    occurredAtEpoch: 1760000000000,
  },
  customMemory: {
    projectId: 'project-id',
    kind: 'manual',
    type: 'note',
    title: 'Decision',
    narrative: 'Store canonical memory records in SQLite; Redis is queue state only.',
    facts: ['SQLite is the source of truth for memories'],
  },
} as const;
