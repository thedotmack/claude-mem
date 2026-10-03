import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { HOOK_TIMEOUTS, hookProcessOverheadMs } from '../../src/shared/hook-constants.js';
import {
  ANTIGRAVITY_HOOK_TIMEOUT_MS,
  SESSION_START_HOOK_LIMIT_MS,
  serverSessionStartBudgetMs,
} from '../../src/shared/host-hook-limits.js';
import { buildAntigravityHooksConfig } from '../../src/services/integrations/AntigravityCliHooksInstaller.js';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, writable: true, configurable: true });
}

afterEach(() => setPlatform(originalPlatform));

type RegisteredHook = { command: string; args?: string[]; timeout?: number };

/**
 * The `timeout` (seconds) of the SessionStart hook that runs `hookInvocation`:
 * Claude Code hooks are exec form (`args`), Codex hooks are shell strings.
 */
function registeredSessionStartTimeoutSeconds(hooksFile: string, hookInvocation: string): number | undefined {
  const parsed = JSON.parse(readFileSync(join(REPO_ROOT, hooksFile), 'utf-8')) as {
    hooks: Record<string, Array<{ hooks: RegisteredHook[] }>>;
  };
  const entry = parsed.hooks.SessionStart
    .flatMap(group => group.hooks)
    .find(hook => Array.isArray(hook.args)
      ? hook.args.join(' ') === hookInvocation
      : hook.command.includes(`"$_P/scripts/worker-service.cjs" ${hookInvocation}`));
  return entry?.timeout;
}

describe('SESSION_START_HOOK_LIMIT_MS', () => {
  it('matches the SessionStart context hook timeouts the plugin registers with each host', () => {
    expect(registeredSessionStartTimeoutSeconds('plugin/hooks/hooks.json', 'hook claude-code context') ?? NaN)
      .toBe(SESSION_START_HOOK_LIMIT_MS['claude-code'] / 1000);
    expect(registeredSessionStartTimeoutSeconds('plugin/hooks/codex-hooks.json', 'hook codex context') ?? NaN)
      .toBe(SESSION_START_HOOK_LIMIT_MS.codex / 1000);
  });

  it('uses the per-hook timeout the Antigravity installer writes for both of its host ids', () => {
    expect(SESSION_START_HOOK_LIMIT_MS['antigravity-cli']).toBe(ANTIGRAVITY_HOOK_TIMEOUT_MS);
    expect(SESSION_START_HOOK_LIMIT_MS.antigravity).toBe(ANTIGRAVITY_HOOK_TIMEOUT_MS);

    // agy reads `timeout` in seconds (#4196); the PreInvocation hook runs `context`.
    const agyHooks = buildAntigravityHooksConfig('/usr/local/bin/bun', '/opt/plugin/scripts/worker-service.cjs') as Record<string, any>;
    const contextHook = agyHooks['claude-mem'].PreInvocation[0];
    expect(contextHook.command).toEndWith('hook antigravity-cli context');
    expect(contextHook.timeout).toBe(ANTIGRAVITY_HOOK_TIMEOUT_MS / 1000);
  });
});

describe('serverSessionStartBudgetMs', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    it(`leaves room for the hook's own startup and exit inside every registered limit (${platform})`, () => {
      setPlatform(platform);
      for (const [host, limitMs] of Object.entries(SESSION_START_HOOK_LIMIT_MS)) {
        const budgetMs = serverSessionStartBudgetMs(host);
        expect(budgetMs).toBeGreaterThan(0);
        expect(budgetMs + hookProcessOverheadMs()).toBeLessThanOrEqual(limitMs);
      }
    });
  }

  it('gives a Codex SessionStart 15 s of its 20 s on POSIX and 12 s on Windows', () => {
    setPlatform('darwin');
    expect(serverSessionStartBudgetMs('codex')).toBe(15_000);
    setPlatform('win32');
    expect(serverSessionStartBudgetMs('codex')).toBe(12_000);
  });

  it('never waits longer than the client default, even under a generous host limit', () => {
    setPlatform('darwin');
    expect(serverSessionStartBudgetMs('claude-code')).toBe(HOOK_TIMEOUTS.API_REQUEST);
    setPlatform('win32');
    expect(serverSessionStartBudgetMs('claude-code'))
      .toBe(Math.round(HOOK_TIMEOUTS.API_REQUEST * HOOK_TIMEOUTS.WINDOWS_MULTIPLIER));
  });

  it('keeps the client default for a host that registers no limit', () => {
    setPlatform('darwin');
    expect(serverSessionStartBudgetMs('cursor')).toBe(HOOK_TIMEOUTS.API_REQUEST);
    expect(serverSessionStartBudgetMs(undefined)).toBe(HOOK_TIMEOUTS.API_REQUEST);
  });
});
