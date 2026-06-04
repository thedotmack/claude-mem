/**
 * Installer error taxonomy — the single source of truth for classifying every
 * failure the universal installer (`npx claude-mem install`) can hit, and the
 * remediation we surface for each.
 *
 * Design constraints (see plans/04-installer-transparency.md):
 *  - Fail loud over silent. Unknown errors default to ABORT until classified.
 *  - Remediation strings interpolate the resolved data dir (multi-account safe),
 *    never a hard-coded ~/.claude-mem path.
 *  - There is NO `SILENT` severity — the closest is SILENT_RETRY (retry once,
 *    then escalate to a visible WARN_CONTINUE).
 */

export enum ErrorSeverity {
  /** exit 1, do not continue. */
  ABORT = 'ABORT',
  /** exit 1 only if all IDEs fail; otherwise partial summary, continue. */
  FAIL_LOUD_PER_IDE = 'FAIL_LOUD_PER_IDE',
  /** print warning to end-of-install summary, continue (exit 0). */
  WARN_CONTINUE = 'WARN_CONTINUE',
  /** retry once with backoff; escalate to WARN_CONTINUE on repeated failure. */
  SILENT_RETRY = 'SILENT_RETRY',
}

export interface RemediationContext {
  platform: NodeJS.Platform;
  /** Resolved data dir (honors CLAUDE_MEM_DATA_DIR). */
  dataDir: string;
}

export interface MatchContext {
  component: string;
  phase: string;
}

export interface ErrorCategory {
  id: string;
  severity: ErrorSeverity;
  match: (cause: unknown, ctx: MatchContext) => boolean;
  remediation: (ctx: RemediationContext) => string;
}

function causeMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  if (cause && typeof cause === 'object' && 'message' in cause) {
    return String((cause as { message: unknown }).message);
  }
  return String(cause ?? '');
}

const BUN_REMEDIATION = (ctx: RemediationContext): string =>
  ctx.platform === 'win32'
    ? 'Install Bun manually then re-run `npx claude-mem install`. Windows: `winget install Oven-sh.Bun` (or `powershell -c "irm bun.sh/install.ps1 | iex"`).'
    : 'Install Bun manually then re-run `npx claude-mem install`. macOS/Linux: `curl -fsSL https://bun.sh/install | bash` (or `brew install oven-sh/bun/bun`).';

const UV_REMEDIATION = (ctx: RemediationContext): string =>
  ctx.platform === 'win32'
    ? 'Install uv manually then re-run `npx claude-mem install`. Windows: `winget install astral-sh.uv` (or `powershell -c "irm https://astral.sh/uv/install.ps1 | iex"`).'
    : 'Install uv manually then re-run `npx claude-mem install`. macOS/Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh` (or `brew install uv`).';

/**
 * The canonical category list. Ordered most-specific-first; `classifyError`
 * returns the first matching category. The trailing `unknown-install-error`
 * default is ABORT — an unclassified failure is a fail-loud failure.
 */
export const ERROR_CATEGORIES: ErrorCategory[] = [
  {
    id: 'bun-missing-after-install',
    severity: ErrorSeverity.ABORT,
    match: (cause) => {
      const m = causeMessage(cause);
      return (
        m.includes('Bun executable not found') ||
        m.includes('Bun installation completed but binary not found') ||
        m.includes('Failed to install Bun')
      );
    },
    remediation: BUN_REMEDIATION,
  },
  {
    id: 'uv-missing-after-install',
    severity: ErrorSeverity.ABORT,
    match: (cause) => {
      const m = causeMessage(cause);
      return (
        m.includes('uv executable not found') ||
        m.includes('uv installed but version probe failed') ||
        m.includes('uv binary not found') ||
        m.includes('Failed to install uv')
      );
    },
    remediation: UV_REMEDIATION,
  },
  {
    id: 'tree-sitter-eresolve',
    severity: ErrorSeverity.ABORT,
    match: (cause) => /\bERESOLVE\b/.test(causeMessage(cause)),
    remediation: () =>
      'ERESOLVE peer-dependency conflict in marketplace deps that --legacy-peer-deps could not resolve. Open an issue at https://github.com/thedotmack/claude-mem/issues with the conflicting peer ranges shown above.',
  },
  {
    id: 'bun-install-network-fail',
    severity: ErrorSeverity.SILENT_RETRY,
    match: (cause) => /error: failed to resolve/.test(causeMessage(cause)),
    remediation: () =>
      'bun install failed to resolve packages — check network connectivity and re-run `npx claude-mem install`. Cached packages in ~/.bun/install/cache will be reused.',
  },
  {
    id: 'marketplace-dir-not-writable',
    severity: ErrorSeverity.ABORT,
    match: (cause) => /\b(EACCES|EPERM)\b/.test(causeMessage(cause)),
    remediation: (ctx) =>
      `Cannot write to the claude-mem data/marketplace directory under ${ctx.dataDir}. Check filesystem permissions or set CLAUDE_MEM_DATA_DIR to a writable path, then re-run.`,
  },
  {
    id: 'plugin-json-corrupt',
    severity: ErrorSeverity.ABORT,
    match: (cause, ctx) =>
      ctx.component === 'plugin-json' &&
      /Unexpected token|JSON|parse/i.test(causeMessage(cause)),
    remediation: () =>
      'Existing plugin.json is corrupt. Run `rm -rf ~/.claude/plugins/marketplaces/thedotmack` and re-run `npx claude-mem install`.',
  },
  {
    id: 'all-ides-failed',
    severity: ErrorSeverity.ABORT,
    match: (_cause, ctx) => ctx.component === 'all-ides',
    remediation: () =>
      'Every selected IDE integration failed. See the per-IDE errors above. Re-run with `--ide=<single>` to isolate the failure.',
  },
  {
    id: 'single-ide-failed',
    severity: ErrorSeverity.FAIL_LOUD_PER_IDE,
    match: (_cause, ctx) => ctx.phase === 'ide-install',
    remediation: () =>
      'Re-run `npx claude-mem install --ide=<name>` to retry just this IDE. The captured stderr is shown above.',
  },
  {
    id: 'path-update-failed',
    severity: ErrorSeverity.WARN_CONTINUE,
    match: (_cause, ctx) => ctx.component === 'path-update',
    remediation: () =>
      'Could not auto-update PATH in your shell config. Add the printed export line manually and restart your shell.',
  },
  {
    id: 'auto-memory-toggle-failed',
    severity: ErrorSeverity.WARN_CONTINUE,
    match: (_cause, ctx) => ctx.component === 'auto-memory',
    remediation: () =>
      'Could not disable Claude Code auto-memory. Add `"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"` to the env block in ~/.claude/settings.json.',
  },
  {
    id: 'version-probe-transient',
    severity: ErrorSeverity.WARN_CONTINUE,
    match: (_cause, ctx) => ctx.component.endsWith('-version-probe'),
    remediation: () =>
      'Could not verify the tool version after install — the installation is likely OK. Re-run `npx claude-mem install` if features misbehave.',
  },
  {
    id: 'child-process-timeout',
    severity: ErrorSeverity.ABORT,
    match: (cause) => /timed out|ETIMEDOUT|SIGTERM|did not finish/i.test(causeMessage(cause)),
    remediation: () =>
      'An install command did not finish in time. Check network connectivity. On a slow host, raise the budget with CLAUDE_MEM_INSTALL_TIMEOUT_MS and re-run.',
  },
  {
    id: 'unknown-install-error',
    severity: ErrorSeverity.ABORT,
    match: () => true,
    remediation: (ctx) =>
      `An unexpected installer error occurred. Capture ${ctx.dataDir}/last-install-error.json and open an issue at https://github.com/thedotmack/claude-mem/issues.`,
  },
];

/**
 * Classify a raw error against the taxonomy. Always returns a category — the
 * fail-loud default (`unknown-install-error`, ABORT) is last in the list.
 */
export function classifyError(cause: unknown, ctx: MatchContext): ErrorCategory {
  for (const category of ERROR_CATEGORIES) {
    if (category.match(cause, ctx)) return category;
  }
  // Unreachable — the default category matches everything — but TypeScript and
  // fail-loud hygiene both want an explicit fallback.
  return ERROR_CATEGORIES[ERROR_CATEGORIES.length - 1];
}
