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
 * re-open the gap.
 *
 * NOTE: every layer only counts if it reaches the `claude` child. The SDK turns
 * them into flags: `--tools ""`, `--disallowedTools`, `--permission-mode
 * dontAsk`, and `canUseTool` via `--permission-prompt-tool stdio`. The Observer
 * spawn factory used to drop the `--tools ""` pair (normalizeSpawnSdkArgs), so
 * the CLI loaded its default tool set and the deny-list did the work of
 * `tools: []`. The pair now reaches the CLI as `--tools=`, and
 * tests/security/observer-tool-enforcement.test.ts pins that argv.
 *
 * Verified against @anthropic-ai/claude-agent-sdk v0.2.141
 * (sdk.d.ts): `tools`, `allowedTools`, `disallowedTools`, `permissionMode`
 * ('dontAsk' = "Don't prompt for permissions, deny if not pre-approved"),
 * `canUseTool` (returns PermissionResult { behavior: 'deny', message }),
 * `additionalDirectories`, `mcpServers`, `settingSources`, `strictMcpConfig`
 * all exist on the `Options` type.
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { ensureObserverSessionsDir } from '../shared/paths.js';
import { recordObserverToolAttempt } from '../utils/observer-audit.js';
import { logger } from '../utils/logger.js';

/**
 * Tools explicitly named in the deny-list.
 *
 * NOTE: `tools: []` already disables all built-ins, but treat every entry as
 * load-bearing anyway and review the list whenever the harness gains a tool:
 * while the spawn factory dropped `--tools` (see the NOTE above), this list
 * was the only enforcement.
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
  'SendMessage',    // No instructing other sessions
  'ListAgents',     // No discovering other sessions to instruct
] as const;

/**
 * WHY SendMessage AND ListAgents ARE ON THAT LIST
 *
 * Every other entry above stops the Observer from acting on the user's machine.
 * These two stop it from asking a session that still can.
 *
 * An Observer with no tools, messaging a working session that has all of them,
 * borrows that session's authority for as far as it can persuade. The system
 * prompt's "You do not have access to tools" stays true the whole time, which
 * is why the property is worth naming separately: what is bounded is the
 * Observer's own reach, not the reach of what it can talk into acting.
 *
 * This is the case the threat model above predicts, arriving through a tool the
 * deny-list had never heard of. It arrived while `--tools ""` was being dropped
 * before the `claude` child saw it (see the NOTE in the module docblock), so
 * this list alone stood between the Observer and SendMessage (#3566). With
 * `--tools=` reaching the CLI, the list is back to being one layer of several.
 *
 * ListAgents rides along because it is how a session finds peers to address.
 * Denying the send while leaving discovery open is half a boundary.
 */

/**
 * The Observer thinking policy for one generation. `disabled` is the shipped
 * default; `'omit'` (the sentinel) drops the field from the request entirely;
 * `{ type: 'adaptive' }` and an `{ type: 'enabled', budgetTokens }` object pass
 * through verbatim.
 * Behavior-only in every case — none of these touch the lockdown boundary.
 */
export type ObserverThinkingOption = Options['thinking'] | 'omit';

/**
 * Budget assumed by `CLAUDE_MEM_OBSERVER_THINKING=enabled` with no `:budget`.
 * Reason: provider minimum. Anthropic's extended thinking requires
 * budget_tokens >= 1024, so this is the smallest budget the API accepts.
 */
export const DEFAULT_OBSERVER_THINKING_BUDGET_TOKENS = 1024;

/**
 * Parse the `CLAUDE_MEM_OBSERVER_THINKING` setting
 * (`disabled | adaptive | enabled[:budget] | omit`, case-insensitive). Models
 * from Claude Haiku 5.5 on accept only adaptive thinking and reject an
 * `enabled` budget with HTTP 400, so `adaptive` is how they think. The empty/absent
 * value parses as `disabled` — the historical behavior — and an unrecognized
 * value falls back to `disabled` with a warn rather than guessing (#4732).
 */
export function resolveObserverThinkingOption(raw: string | undefined): ObserverThinkingOption {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'omit') return 'omit';
  if (value === 'adaptive') return { type: 'adaptive' };
  if (value === 'enabled' || value.startsWith('enabled:')) {
    const budgetRaw = value.slice('enabled:'.length);
    const budget = parseInt(budgetRaw, 10);
    if (budgetRaw !== '' && Number.isFinite(budget) && budget >= DEFAULT_OBSERVER_THINKING_BUDGET_TOKENS) {
      return { type: 'enabled', budgetTokens: budget };
    }
    if (budgetRaw !== '' && Number.isFinite(budget) && budget > 0) {
      // The API rejects a smaller budget with a 400 on every request.
      logger.warn('SDK', `Raising the CLAUDE_MEM_OBSERVER_THINKING budget "${budgetRaw}" to the API minimum ${DEFAULT_OBSERVER_THINKING_BUDGET_TOKENS}`);
      return { type: 'enabled', budgetTokens: DEFAULT_OBSERVER_THINKING_BUDGET_TOKENS };
    }
    if (budgetRaw !== '') {
      logger.warn('SDK', `Ignoring the non-positive CLAUDE_MEM_OBSERVER_THINKING budget "${budgetRaw}"; using ${DEFAULT_OBSERVER_THINKING_BUDGET_TOKENS}`);
    }
    return { type: 'enabled', budgetTokens: DEFAULT_OBSERVER_THINKING_BUDGET_TOKENS };
  }
  if (value !== '' && value !== 'disabled') {
    logger.warn('SDK', `Ignoring unrecognized CLAUDE_MEM_OBSERVER_THINKING value "${raw}"; keeping thinking disabled (supported: disabled | adaptive | enabled[:budget] | omit)`);
  }
  return { type: 'disabled' };
}

export interface HardenedSdkOptionsInput {
  /** Which call site is constructing options — flows into audit entries. */
  source: 'Observer' | 'KnowledgeAgent';
  /** Identifiers carried into the audit log for post-incident correlation. */
  sessionDbId?: number;
  contentSessionId?: string;
  project?: string;

  /**
   * Observer thinking policy (#4732). Only honored for `source: 'Observer'` —
   * KnowledgeAgent never sends a thinking field, whatever this says. Defaults
   * to `disabled` when the caller passes nothing, preserving the shipped
   * behavior for Anthropic-native endpoints; an always-thinking gateway
   * upstream rejects `disabled` with HTTP 400/1210, so operators can set
   * `omit` (or an enabled budget) via CLAUDE_MEM_OBSERVER_THINKING, and the
   * provider strips the param itself after one such rejection.
   */
  thinking?: ObserverThinkingOption;

  // Pass-through fields the caller still owns:
  model: string;
  env: NodeJS.ProcessEnv;
  pathToClaudeCodeExecutable: string;
  /**
   * Defaults to OBSERVER_SESSIONS_DIR, created here so every query path (Observer,
   * standalone prompt, KnowledgeAgent) gets it. Never falls back to process.cwd().
   */
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
    cwd: input.cwd ?? ensureObserverSessionsDir(),
    env: input.env,
    pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
    ...(input.abortController ? { abortController: input.abortController } : {}),
    ...(input.resume ? { resume: input.resume } : {}),
    ...(input.spawnClaudeCodeProcess ? { spawnClaudeCodeProcess: input.spawnClaudeCodeProcess } : {}),
    // Observer thinking is behavior-only and does not participate in the lockdown boundary.
    // Default stays `disabled` (shipped behavior); an always-thinking gateway
    // upstream rejects it with 400/1210 (#4732), so the caller can pass 'omit'
    // or an enabled budget instead — never honored for KnowledgeAgent.
    ...(input.source === 'Observer' && input.thinking !== 'omit'
      ? { thinking: input.thinking ?? { type: 'disabled' as const } }
      : {}),

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
