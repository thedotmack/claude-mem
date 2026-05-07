// SPDX-License-Identifier: Apache-2.0

import { serverMemoryPrompts } from './prompts.js';
import { serverMemoryResources } from './resources.js';
import { serverMemoryTools } from './tools.js';

export function getServerMcpSurface() {
  return {
    tools: serverMemoryTools,
    resources: serverMemoryResources,
    prompts: serverMemoryPrompts,
  };
}
