// SPDX-License-Identifier: Apache-2.0

export const serverMemoryPrompts = [
  {
    name: 'record_decision',
    description: 'Capture a project decision in Claude-Mem Server memory.',
    arguments: [
      { name: 'projectId', description: 'Server project id', required: true },
      { name: 'decision', description: 'Decision text', required: true },
    ],
  },
] as const;
