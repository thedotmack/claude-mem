/**
 * Single source of truth for the SECURITY-SENSITIVE SDK options that lock the
 * Observer and KnowledgeAgent sessions down to "no tool access".
 *
 * THREAT MODEL
 * ------------
 * The Observer/KnowledgeAgent system prompts assert "You do not have access to
 * tools" (see plugin/modes/*.json — `system_identity`). Historically that
 * guarantee was enforced ONLY by `disallowedTools`. If a future SDK release
 * shipped a new built-in tool that was not in our deny-list, the Observer could
 * autonomously call Edit/Write/Bash on the user's source tree. This helper
 * makes the prompt's guarantee true at the SDK-config layer with a simplified
 * two-layer model:
 *
 *   - restriction: `tools: []`           — the SDK's TRUE restrictive allowlist.
 *                                          Per the SDK type docs, `tools: []`
 *                                          disables ALL built-in tools. (Note:
 *                                          `allowedTools` is an AUTO-APPROVE
 *                                          list, NOT a restriction, so it is
 *                                          not part of this model.)
 *   - backstop:    `canUseTool`          — denies EVERY invocation and writes an
 *                                          append-only audit entry.
 *
 * Three formerly redundant layers — `allowedTools: []`, `disallowedTools`
 * (the explicit per-tool deny list), and `permissionMode: 'dontAsk'` — were
 * removed. All three operate on a tool surface that `tools: []` has already
 * emptied: once the SDK's built-in tool list is `[]`, there is nothing left
 * for an auto-approve list, a deny list, or a permission-prompt mode to act
 * on. Keeping them added no independent security property, only maintenance
 * surface (e.g. a deny-list that could silently drift out of sync with a new
 * SDK-added tool while still being masked by `tools: []`).
 *
 * `systemPrompt` (below) adds a defense-in-depth layer of its own, separate
 * from tool lockdown: it re-asserts the "no tool access" identity text
 * directly in the subprocess's system prompt, complementing
 * `settingSources: []` which already suppresses CLAUDE.md inheritance.
 *
 *   - isolation:   `cwd` jail + `mcpServers:{}` + `settingSources:[]` +
 *                  `strictMcpConfig` + `additionalDirectories:[]` — even with
 *                  tools disabled, these prevent settings/MCP inheritance and
 *                  filesystem escape hatches.
 *
 * Verified against @anthropic-ai/claude-agent-sdk v0.2.141 (sdk.d.ts):
 * `tools`, `canUseTool` (returns PermissionResult { behavior: 'deny', message }),
 * `additionalDirectories`, `mcpServers`, `settingSources`, `strictMcpConfig`,
 * `systemPrompt` all exist on the `Options` type.
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { OBSERVER_SESSIONS_DIR } from '../shared/paths.js';
import { recordObserverToolAttempt } from '../utils/observer-audit.js';
import { logger } from '../utils/logger.js';

export interface HardenedSdkOptionsInput {
  /** Which call site is constructing options — flows into audit entries. */
  source: 'Observer' | 'KnowledgeAgent';
  /** Identifiers carried into the audit log for post-incident correlation. */
  sessionDbId?: number;
  contentSessionId?: string;
  project?: string;

  /** System identity text for the subprocess (defense-in-depth). */
  systemPrompt: string;

  // Pass-through fields the caller still owns:
  model: string;
  env: NodeJS.ProcessEnv;
  pathToClaudeCodeExecutable: string;
  /** Defaults to OBSERVER_SESSIONS_DIR. Never falls back to process.cwd(). */
  cwd?: string;
  abortController?: AbortController;
  resume?: string;
  /** SDK SpawnFactory — typed via the SDK's own Options field. */
  spawnClaudeCodeProcess?: Options['spawnClaudeCodeProcess'];
}

/**
 * Build the fully hardened `Options` object for an Observer/KnowledgeAgent
 * `query()` call. Both call sites MUST go through this helper so the lockdown
 * cannot drift between them.
 */
export function buildHardenedSdkOptions(input: HardenedSdkOptionsInput): Options {
  const canUseTool: Options['canUseTool'] = async (toolName, toolInput) => {
    recordObserverToolAttempt({
      source: input.source,
      sessionDbId: input.sessionDbId,
      contentSessionId: input.contentSessionId,
      project: input.project,
      tool_name: toolName,
      tool_input: toolInput,
      result: 'denied',
    });
    // Real-time visibility for the persistent audit trail. The append-only log
    // (recordObserverToolAttempt above) is the authoritative record; this WARN
    // surfaces the attempt in the live worker log for incident detection.
    logger.warn('SECURITY', `Blocked tool use by ${input.source}: ${toolName}`, {
      sessionId: input.sessionDbId,
      source: input.source,
      tool_name: toolName,
    });
    return {
      behavior: 'deny',
      message: `${input.source} is forbidden from tool use (claude-mem hard lockdown).`,
    };
  };

  return {
    model: input.model,
    cwd: input.cwd ?? OBSERVER_SESSIONS_DIR,
    env: input.env,
    pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
    systemPrompt: input.systemPrompt,
    ...(input.abortController ? { abortController: input.abortController } : {}),
    ...(input.resume ? { resume: input.resume } : {}),
    ...(input.spawnClaudeCodeProcess ? { spawnClaudeCodeProcess: input.spawnClaudeCodeProcess } : {}),
    // Observer thinking is behavior-only and does not participate in the lockdown boundary.
    ...(input.source === 'Observer' ? { thinkingConfig: { type: 'disabled' as const } } : {}),

    // === Tool lockdown (defense-in-depth) ===
    tools: [],                                        // restriction: disable ALL built-in tools
    canUseTool,                                       // backstop: deny + audit every attempt

    // === Filesystem / settings / MCP isolation ===
    additionalDirectories: [],                        // no extra writable roots
    mcpServers: {},                                   // no MCP tool surface
    settingSources: [],                               // no ~/.claude settings inheritance
    strictMcpConfig: true,
  };
}
