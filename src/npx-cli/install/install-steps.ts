/**
 * `install_step` telemetry: exactly one event per installer step, closed lists
 * only. Events are sent concurrently and awaited once at the end (flush), so a
 * slow telemetry host adds at most one 2s timeout to an install, not one per
 * step.
 */

import { captureCliEvent } from '../../services/telemetry/cli-telemetry.js';
import { InstallAbortError } from './error-reporter.js';

export const INSTALL_STEP_IDS = [
  'detect',
  'marketplace.copy',
  'plugin.cache',
  'marketplace.register',
  'plugin.register',
  'plugin.enable',
  'bun.ensure',
  'uv.ensure',
  'plugin.deps',
  'marketplace.deps',
  'provider',
  'worker.start',
  'signin',
] as const;
export type FixedStepId = (typeof INSTALL_STEP_IDS)[number];
/** `ide.<id>` carries one of OUR IDE ids (ide-detection.ts). */
export type InstallStepId = FixedStepId | `ide.${string}`;

export const INSTALL_STEP_ID_RE = new RegExp(
  `^(?:${INSTALL_STEP_IDS.map((id) => id.replace('.', '\\.')).join('|')}|ide\\.[a-z0-9-]{1,40})$`,
);

export type AgentContext = 'claude-code' | 'cursor' | 'codex' | 'unknown-non-tty' | 'tty';
export const AGENT_CONTEXTS: readonly AgentContext[] = ['claude-code', 'cursor', 'codex', 'unknown-non-tty', 'tty'];

/**
 * Which agent (if any) is running the installer, from env markers only —
 * never a process listing. AI_AGENT is the cross-vendor marker; its value is
 * matched against the known ids and otherwise ignored.
 */
export function detectAgentContext(env: NodeJS.ProcessEnv, isTTY: boolean): AgentContext {
  if (env.CLAUDECODE === '1' || env.AI_AGENT?.toLowerCase().includes('claude')) return 'claude-code';
  if (env.CURSOR_AGENT || env.AI_AGENT?.toLowerCase().includes('cursor')) return 'cursor';
  if (env.CODEX_SANDBOX || env.AI_AGENT?.toLowerCase().includes('codex')) return 'codex';
  return isTTY ? 'tty' : 'unknown-non-tty';
}

export type StepOutcome = 'ok' | 'error' | 'skipped';

export interface StepExtra {
  error_category?: string;
  fix_id?: string;
  fix_outcome?: 'ok' | 'error';
  attempt_n?: number;
  bun_fail_reason?: string;
  browser_open?: string;
  signin_arm?: string;
}

type Emit = (event: string, props: Record<string, unknown>) => Promise<void>;

export class StepTracker {
  private readonly pending: Promise<void>[] = [];
  private readonly emitted = new Set<string>();
  /** The step running now; the abort path reports it as `failed_step`. */
  current: InstallStepId | null = null;

  constructor(
    private readonly base: { version: string; agent_context: AgentContext; interactive: boolean },
    private readonly emit: Emit = (event, props) => captureCliEvent(event, props),
  ) {}

  /** Record one step. A second record for the same step id is ignored. */
  record(stepId: InstallStepId, outcome: StepOutcome, durationMs: number, extra: StepExtra = {}): void {
    if (this.emitted.has(stepId)) return;
    this.emitted.add(stepId);
    this.pending.push(this.emit('install_step', {
      ...this.base,
      step_id: stepId,
      outcome,
      duration_ms: Math.max(0, Math.round(durationMs)),
      ...extra,
    }));
  }

  /**
   * Run `fn` as step `stepId`. A thrown InstallAbortError records `error`
   * with its category and is rethrown unchanged. `failed` lets a step that
   * reports failure without throwing (an IDE recorded on the summary) say so.
   */
  async run<T>(
    stepId: InstallStepId,
    fn: () => Promise<T>,
    opts: { failed?: () => boolean; skipped?: () => boolean; extra?: () => StepExtra } = {},
  ): Promise<T> {
    const started = Date.now();
    this.current = stepId;
    try {
      const result = await fn();
      this.current = null;
      this.record(stepId, opts.failed?.() ? 'error' : opts.skipped?.() ? 'skipped' : 'ok', Date.now() - started, opts.extra?.() ?? {});
      return result;
    } catch (error: unknown) {
      this.record(stepId, 'error', Date.now() - started, {
        ...(opts.extra?.() ?? {}),
        error_category: error instanceof InstallAbortError ? error.category.id : 'unknown-install-error',
      });
      throw error;
    }
  }

  recordedSteps(): string[] {
    return [...this.emitted];
  }

  /** Waits for every queued event; never rejects (captureCliEvent never does). */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pending);
  }
}
