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
 * makes the prompt's guarantee true at the SDK-config layer with
 * defense-in-depth — no single option is load-bearing:
 *
 *   - belt:        `tools: []`           — the SDK's TRUE restrictive allowlist.
 *                                          Per the SDK type docs, `tools: []`
 *                                          disables ALL built-in tools. (Note:
 *                                          `allowedTools` is an AUTO-APPROVE
 *                                          list, NOT a restriction — see below.)
 *   - empty allow: `allowedTools: []`    — nothing is auto-approved.
 *   - suspenders:  `disallowedTools`     — explicit per-tool deny list.
 *   - braces:      `permissionMode`      — 'dontAsk' = deny unless pre-approved
 *                                          (nothing is pre-approved here).
 *   - backstop:    `canUseTool`          — denies EVERY invocation and writes an
 *                                          append-only audit entry.
 *   - isolation:   `cwd` jail + `mcpServers:{}` + `settingSources:[]` +
 *                  `strictMcpConfig` + `additionalDirectories:[]` — even with
 *                  tools disabled, these prevent settings/MCP inheritance and
 *                  filesystem escape hatches.
 *
 * The redundancy IS the security property: removing any one layer must not
 * re-open the gap. Verified against @anthropic-ai/claude-agent-sdk v0.2.141
 * (sdk.d.ts): `tools`, `allowedTools`, `disallowedTools`, `permissionMode`
 * ('dontAsk' = "Don't prompt for permissions, deny if not pre-approved"),
 * `canUseTool` (returns PermissionResult { behavior: 'deny', message }),
 * `additionalDirectories`, `mcpServers`, `settingSources`, `strictMcpConfig`
 * all exist on the `Options` type.
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { OBSERVER_SESSIONS_DIR } from '../shared/paths.js';
import { recordObserverToolAttempt } from '../utils/observer-audit.js';
import { logger } from '../utils/logger.js';

/**
 * Tools explicitly named in the deny-list. `tools: []` already disables all
 * built-ins; this list is the redundant "suspenders" layer and documents
 * intent for human reviewers.
 */
export const OBSERVER_DISALLOWED_TOOLS = [
  'Bash',           // Prevent infinite loops
  'Read',           // No file reading
  'Write',          // No file writing
  'Edit',           // No file editing
  'Grep',           // No code searching
  'Glob',           // No file pattern matching
  'WebFetch',       // No web fetching
  'WebSearch',      // No web searching
  'Task',           // No spawning sub-agents
  'NotebookEdit',   // No notebook editing
  'AskUserQuestion',// No asking questions
  'TodoWrite',
] as const;

export interface HardenedSdkOptionsInput {
  /** Which call site is constructing options — flows into audit entries. */
  source: 'Observer' | 'KnowledgeAgent';
  /** Identifiers carried into the audit log for post-incident correlation. */
  sessionDbId?: number;
  contentSessionId?: string;
  project?: string;

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
    ...(input.abortController ? { abortController: input.abortController } : {}),
    ...(input.resume ? { resume: input.resume } : {}),
    ...(input.spawnClaudeCodeProcess ? { spawnClaudeCodeProcess: input.spawnClaudeCodeProcess } : {}),

    // === Tool lockdown (defense-in-depth) ===
    tools: [],                                        // belt: disable ALL built-in tools
    allowedTools: [],                                 // nothing auto-approved
    disallowedTools: [...OBSERVER_DISALLOWED_TOOLS],  // suspenders: explicit deny
    permissionMode: 'dontAsk',                        // braces: deny unless pre-approved (nothing is)
    canUseTool,                                       // backstop: deny + audit every attempt

    // === Filesystem / settings / MCP isolation ===
    additionalDirectories: [],                        // no extra writable roots
    mcpServers: {},                                   // no MCP tool surface
    settingSources: [],                               // no ~/.claude settings inheritance
    strictMcpConfig: true,
  };
}
