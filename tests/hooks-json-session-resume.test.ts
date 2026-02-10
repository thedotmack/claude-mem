/**
 * Hooks JSON SessionStart Resume Matcher Test
 *
 * Validates that the SessionStart hook fires on `resume` events (--continue, --resume, /resume).
 * Without `resume` in the matcher, context injection is skipped on session resumption,
 * which can cause stale or missing context and internal agent output leaking (#784).
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dir, '..');

describe('hooks.json SessionStart configuration', () => {
  it('should include resume in SessionStart matcher for --continue support (#784)', () => {
    const hooksPath = join(PROJECT_ROOT, 'plugin', 'hooks', 'hooks.json');
    const hooksJson = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    const sessionStartHooks = hooksJson.hooks?.SessionStart;
    expect(sessionStartHooks).toBeDefined();
    expect(Array.isArray(sessionStartHooks)).toBe(true);
    expect(sessionStartHooks.length).toBeGreaterThan(0);

    const matcher = sessionStartHooks[0].matcher;
    expect(matcher).toBeDefined();

    // Matcher is a regex string - verify 'resume' is included
    const matcherRegex = new RegExp(matcher);
    expect(matcherRegex.test('resume')).toBe(true);
    expect(matcherRegex.test('startup')).toBe(true);
    expect(matcherRegex.test('clear')).toBe(true);
    expect(matcherRegex.test('compact')).toBe(true);
  });

  it('should have context hook as the last SessionStart hook', () => {
    const hooksPath = join(PROJECT_ROOT, 'plugin', 'hooks', 'hooks.json');
    const hooksJson = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    const hooks = hooksJson.hooks.SessionStart[0].hooks;
    const lastHook = hooks[hooks.length - 1];

    // The context injection hook should be the last one (after worker start)
    expect(lastHook.command).toContain('hook claude-code context');
  });
});
