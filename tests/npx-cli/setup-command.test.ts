// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import { formatCurrentConfig, selectWorkerScriptPath } from '../../src/npx-cli/commands/setup.js';

describe('setup — current-config summary', () => {
  it('falls back to claude/worker defaults on an empty settings record', () => {
    const lines = formatCurrentConfig({});
    expect(lines).toContain('provider  claude');
    expect(lines).toContain('model     (default)');
    expect(lines).toContain('runtime   worker');
  });

  it('renders stored provider, auth method, and model for the claude path', () => {
    const lines = formatCurrentConfig({
      CLAUDE_MEM_PROVIDER: 'claude',
      CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription',
      CLAUDE_MEM_MODEL: 'claude-haiku-4-5-20251001',
      CLAUDE_MEM_RUNTIME: 'worker',
    });
    expect(lines).toContain('provider  claude (subscription)');
    expect(lines).toContain('model     claude-haiku-4-5-20251001');
    expect(lines).toContain('runtime   worker');
  });

  it('omits the model line for non-claude providers', () => {
    const lines = formatCurrentConfig({ CLAUDE_MEM_PROVIDER: 'openrouter' });
    expect(lines).toContain('provider  openrouter');
    expect(lines.some((line) => line.startsWith('model'))).toBe(false);
  });

  it('displays the legacy server-beta runtime literal as canonical server', () => {
    // Phase 1d dual-accept: stored `server-beta` must render as `server`.
    const lines = formatCurrentConfig({ CLAUDE_MEM_RUNTIME: 'server-beta' });
    expect(lines).toContain('runtime   server');
  });

  it('treats non-string and whitespace-only values as unset', () => {
    const lines = formatCurrentConfig({
      CLAUDE_MEM_PROVIDER: '   ',
      CLAUDE_MEM_MODEL: 42,
      CLAUDE_MEM_RUNTIME: undefined,
    });
    expect(lines).toContain('provider  claude');
    expect(lines).toContain('model     (default)');
    expect(lines).toContain('runtime   worker');
  });
});

describe('setup — worker script selection', () => {
  const marketplace = '/mkt/plugin/scripts/worker-service.cjs';
  const cache = '/cache/scripts/worker-service.cjs';

  it('prefers the marketplace script when it exists', () => {
    const picked = selectWorkerScriptPath([marketplace, cache], (p) => p === marketplace);
    expect(picked).toBe(marketplace);
  });

  it('falls back to the plugin cache script when only that one exists', () => {
    const picked = selectWorkerScriptPath([marketplace, cache], (p) => p === cache);
    expect(picked).toBe(cache);
  });

  // Regression: setup must not shut the worker down when there is nothing to
  // restart it with. `ensureWorkerStarted` only rejects a missing script after
  // the shutdown has landed, so an unchecked fallback path turned a
  // settings-only `setup` into an outage.
  it('returns undefined when neither candidate exists, so the running worker is left alone', () => {
    const picked = selectWorkerScriptPath([marketplace, cache], () => false);
    expect(picked).toBeUndefined();
  });
});
