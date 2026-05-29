/**
 * Central installer error decision point. Every catch in installer paths routes
 * through `installerError(severity, ctx, summary)` instead of an ad-hoc
 * console.warn. The severity (from the taxonomy) decides what happens:
 *
 *   ABORT             -> write last-install-error.json, throw InstallAbortError
 *   FAIL_LOUD_PER_IDE -> record the failed IDE + a warning, continue
 *   WARN_CONTINUE     -> enqueue a warning to the summary, continue
 *   SILENT_RETRY      -> count the retry; escalate to WARN_CONTINUE after 2
 *
 * Warnings are NEVER printed live (a clack spinner would clobber them); they are
 * collected on the summary and flushed by `flushSummary` after the spinners.
 *
 * See plans/04-installer-transparency.md (Phase 3).
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  classifyError,
  ErrorSeverity,
  type ErrorCategory,
} from './error-taxonomy.js';
import { resolveDataDir } from '../../shared/paths.js';

export class InstallAbortError extends Error {
  readonly category: ErrorCategory;
  readonly remediation: string;

  constructor(message: string, options: {
    category: ErrorCategory;
    remediation: string;
    cause: unknown;
  }) {
    super(message, { cause: options.cause });
    this.name = 'InstallAbortError';
    this.category = options.category;
    this.remediation = options.remediation;
  }
}

export interface ErrorContext {
  /** 'cursor', 'codex-cli', 'marketplace-npm-install', 'uv-install', etc. */
  component: string;
  /** 'setup-runtime', 'ide-install', 'marketplace-deps', etc. */
  phase: string;
  cause: unknown;
  /** Optional remediation override; defaults to the taxonomy's. */
  remediation?: string;
  /** Raw stderr block to surface verbatim (e.g. an ERESOLVE conflict). */
  details?: string;
  /** Override the IDE id recorded for FAIL_LOUD_PER_IDE (defaults to component). */
  ide?: string;
}

export interface InstallWarning {
  component: string;
  message: string;
  remediation: string;
}

export interface InstallSummary {
  warnings: InstallWarning[];
  failedIDEs: string[];
  retryCount: Record<string, number>;
}

export function createInstallSummary(): InstallSummary {
  return { warnings: [], failedIDEs: [], retryCount: {} };
}

function causeMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause ?? '');
}

/**
 * Persist a structured record of the aborting failure for post-mortem. Best
 * effort: a failed write must never mask the original error.
 */
function writeLastInstallError(
  category: ErrorCategory,
  ctx: ErrorContext,
  remediation: string,
  dataDir: string,
): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const payload = {
      severity: category.severity,
      categoryId: category.id,
      component: ctx.component,
      phase: ctx.phase,
      cause: causeMessage(ctx.cause),
      remediation,
      details: ctx.details ?? null,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(dataDir, 'last-install-error.json'), JSON.stringify(payload, null, 2));
  } catch {
    // Diagnostics are best-effort; never let them mask the real failure.
  }
}

/**
 * The single decision point. ABORT throws InstallAbortError (the top-level
 * handler prints + exits 1). Every other severity records to the summary and
 * returns.
 */
export function installerError(
  severity: ErrorSeverity,
  ctx: ErrorContext,
  summary: InstallSummary,
): void {
  const dataDir = resolveDataDir();
  const category = classifyError(ctx.cause, { component: ctx.component, phase: ctx.phase });
  const remediation =
    ctx.remediation ??
    category.remediation({ platform: process.platform, dataDir });

  switch (severity) {
    case ErrorSeverity.ABORT: {
      writeLastInstallError(category, ctx, remediation, dataDir);
      throw new InstallAbortError(
        `${ctx.component} failed during ${ctx.phase}: ${causeMessage(ctx.cause)}`,
        { category, remediation, cause: ctx.cause },
      );
    }
    case ErrorSeverity.FAIL_LOUD_PER_IDE: {
      const ide = ctx.ide ?? ctx.component;
      if (!summary.failedIDEs.includes(ide)) summary.failedIDEs.push(ide);
      summary.warnings.push({
        component: ide,
        message: ctx.details ? `${causeMessage(ctx.cause)}\n${ctx.details}` : causeMessage(ctx.cause),
        remediation,
      });
      return;
    }
    case ErrorSeverity.WARN_CONTINUE: {
      summary.warnings.push({
        component: ctx.component,
        message: causeMessage(ctx.cause),
        remediation,
      });
      return;
    }
    case ErrorSeverity.SILENT_RETRY: {
      const count = (summary.retryCount[ctx.component] ?? 0) + 1;
      summary.retryCount[ctx.component] = count;
      if (count > 1) {
        // Exhausted the retry budget — make it visible.
        summary.warnings.push({
          component: ctx.component,
          message: causeMessage(ctx.cause),
          remediation,
        });
      }
      return;
    }
  }
}

/**
 * Run `action`, retrying once on failure for SILENT_RETRY-classified errors.
 * After the budget is exhausted, the failure is re-thrown so the caller can
 * route it through `installerError` with a terminal severity.
 */
export async function withRetry<T>(
  action: () => Promise<T>,
  ctx: ErrorContext,
  summary: InstallSummary,
  maxAttempts = 2,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      const count = (summary.retryCount[ctx.component] ?? 0) + 1;
      summary.retryCount[ctx.component] = count;
      if (attempt >= maxAttempts) break;
    }
  }
  throw lastError;
}

/**
 * Print all collected WARN_CONTINUE / FAIL_LOUD warnings after the spinners
 * have stopped. ANSI is left to the caller's logger; here we keep it plain so
 * the same call works interactive and non-interactive.
 */
export function flushSummary(
  summary: InstallSummary,
  emit: (line: string) => void,
): void {
  if (summary.warnings.length === 0) return;
  emit('');
  emit('Warnings & remediation:');
  for (const warning of summary.warnings) {
    emit(`  • [${warning.component}] ${warning.message}`);
    if (warning.remediation && warning.remediation !== 'No action required.') {
      emit(`    → ${warning.remediation}`);
    }
  }
}
