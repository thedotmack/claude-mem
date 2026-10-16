// SPDX-License-Identifier: Apache-2.0
//
// Which agent sent a request (plan Phase 4 task 1). The route's agentId is
// authoritative. Only a generic route falls back to the User-Agent, using
// the prefix table of plan Appendix A (magpie's per-agent `UA` lists, read
// the way `usage.AgentOf` reads them: internal/usage/usage.go:325-346, plus
// `isClaudeDesktop`, internal/gateway/desktop.go:366-369; MIT, Copyright (c)
// 2026 yetone). Nothing recognised is "unknown": an unknown platform is
// better than a wrong one (claude-mem PR #1474).

export const UNKNOWN_AGENT_ID = 'unknown';

/** Route agent ids that name no agent, so the User-Agent decides. */
export const GENERIC_ROUTE_AGENT_IDS: ReadonlySet<string> = new Set(['generic', UNKNOWN_AGENT_ID]);

/** Appendix A "UA prefixes", matched against the product name (before the first "/" and space), lower-cased. */
const USER_AGENT_PRODUCT_PREFIXES: ReadonlyArray<{ agentId: string; prefixes: readonly string[] }> = [
  { agentId: 'claude-code', prefixes: ['claude-cli', 'claude-code'] },
  { agentId: 'codex', prefixes: ['codex', 'acp-extension-codex'] },
  { agentId: 'gemini-cli', prefixes: ['geminicli', 'gemini-cli'] },
  { agentId: 'opencode', prefixes: ['opencode'] },
  { agentId: 'crush', prefixes: ['crush'] },
  { agentId: 'goose', prefixes: ['goose'] },
  { agentId: 'pi', prefixes: ['pi-'] },
  { agentId: 'omp', prefixes: ['oh-my-pi'] },
  { agentId: 'cline', prefixes: ['cline'] },
  { agentId: 'qwen', prefixes: ['qwencode'] },
  { agentId: 'kimi', prefixes: ['kimicli'] },
  { agentId: 'droid', prefixes: ['factory-cli'] },
  { agentId: 'zed', prefixes: ['zed'] },
  { agentId: 'vscode-chat', prefixes: ['githubcopilotchat'] },
  { agentId: 'hermes', prefixes: ['hermes-agent'] },
  { agentId: 'cursor-private-inference', prefixes: ['cursor'] },
  { agentId: 'kilo', prefixes: ['kilo'] },
  { agentId: 'aider', prefixes: ['aider', 'litellm'] },
];

/** Claude Desktop's Electron User-Agent: `Mozilla/…` with a ` Claude/<version>` token. */
function isClaudeDesktopUserAgent(userAgent: string): boolean {
  return userAgent.startsWith('Mozilla/') && userAgent.includes(' Claude/');
}

/** The agent a User-Agent names, or "unknown". */
export function agentIdFromUserAgent(userAgent: string | null): string {
  if (!userAgent) return UNKNOWN_AGENT_ID;
  if (isClaudeDesktopUserAgent(userAgent)) return 'claude-desktop';
  const product = userAgent.split('/')[0].split(' ')[0].trim().toLowerCase();
  if (product === '') return UNKNOWN_AGENT_ID;
  for (const { agentId, prefixes } of USER_AGENT_PRODUCT_PREFIXES) {
    if (prefixes.some(prefix => product.startsWith(prefix))) return agentId;
  }
  return UNKNOWN_AGENT_ID;
}

/** The route's agent, or, on a generic route, the User-Agent's. */
export function resolveAgentId(routeAgentId: string, userAgent: string | null): string {
  return GENERIC_ROUTE_AGENT_IDS.has(routeAgentId) ? agentIdFromUserAgent(userAgent) : routeAgentId;
}
