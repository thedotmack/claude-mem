// SPDX-License-Identifier: Apache-2.0

export const serverMemoryResources = [
  {
    uri: 'claude-mem://server/projects',
    name: 'Claude-Mem Server Projects',
    description: 'Authorized project list exposed by Claude-Mem Server.',
    mimeType: 'application/json',
  },
  {
    uri: 'claude-mem://server/memories/recent',
    name: 'Recent Claude-Mem Server Memories',
    description: 'Recent authorized memory items from the server core.',
    mimeType: 'application/json',
  },
] as const;
