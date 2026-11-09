// SPDX-License-Identifier: Apache-2.0
//
// Built-in plus user agent descriptors, looked up by id or alias.

import { AGENTS_WITHOUT_DESCRIPTORS, BUILT_IN_AGENT_DESCRIPTORS } from './builtin-agents.js';
import { defaultUserAgentsDirectory, loadUserAgentDescriptors } from './user-agents.js';
import type { AgentDescriptor } from './types.js';

export interface AgentRegistry {
  descriptors: AgentDescriptor[];
  /** User descriptor files that were refused, with why. */
  refusals: string[];
}

export function builtInAgentNames(): Set<string> {
  return new Set(BUILT_IN_AGENT_DESCRIPTORS.flatMap((descriptor) => [descriptor.id, ...(descriptor.aliases ?? [])]));
}

export function loadAgentRegistry(options: { userAgentsDirectory?: string } = {}): AgentRegistry {
  const user = loadUserAgentDescriptors(options.userAgentsDirectory ?? defaultUserAgentsDirectory(), builtInAgentNames());
  return { descriptors: [...BUILT_IN_AGENT_DESCRIPTORS, ...user.descriptors], refusals: user.refusals };
}

/** The descriptor named by id or alias. Throws with the names that exist, and what to do for agents without one. */
export function requireAgentDescriptor(registry: AgentRegistry, name: string): AgentDescriptor {
  const wanted = name.toLowerCase();
  const found = registry.descriptors.find((descriptor) => descriptor.id === wanted || (descriptor.aliases ?? []).includes(wanted));
  if (found) return found;
  const without = AGENTS_WITHOUT_DESCRIPTORS.find((note) => note.id === wanted);
  const lines = [
    without
      ? `${wanted} has no wiring descriptor: ${without.reason}.`
      : `Unknown agent "${name}".`,
    `Agents claude-mem can wire: ${registry.descriptors.map((descriptor) => descriptor.id).join(', ')}.`,
    'For any other agent that takes a base URL: claude-mem wire routes add <routeId> --agent <id> --upstream <its provider URL>,',
    'then point the agent at the printed URL; or describe it in a JSON file under <data dir>/wire-gateway/agents/.',
  ];
  if (registry.refusals.length > 0) lines.push(`Refused agent descriptors: ${registry.refusals.join(' | ')}`);
  throw new Error(lines.join('\n'));
}
