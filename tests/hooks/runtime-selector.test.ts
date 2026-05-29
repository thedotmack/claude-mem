// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';

// Snapshot real modules BEFORE mock.module mutates the live namespace, then
// re-register in afterAll. bun's mock.module is process-global and survives
// mock.restore(), so these would otherwise leak into later test files.
import * as realHookSettings from '../../src/shared/hook-settings.js';
import * as realLogger from '../../src/utils/logger.js';
const realHookSettingsSnapshot = { ...realHookSettings };
const realLoggerSnapshot = { ...realLogger };

let mockSettings: Record<string, string> = {};

mock.module('../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ ...mockSettings }),
}));

const warnLogs: Array<{ msg: string; details?: unknown }> = [];
mock.module('../../src/utils/logger.js', () => ({
  logger: {
    warn: (_component: string, msg: string, details?: unknown) => {
      warnLogs.push({ msg, details });
    },
    info: () => {},
    debug: () => {},
    error: () => {},
    failure: () => {},
    dataIn: () => {},
    formatTool: () => '',
  },
}));

afterAll(() => {
  mock.module('../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../src/utils/logger.js', () => realLoggerSnapshot);
});

import {
  resolveRuntimeContext,
  selectRuntime,
  buildServerContext,
  logServerFallback,
} from '../../src/services/hooks/runtime-selector.js';

describe('runtime-selector', () => {
  beforeEach(() => {
    mockSettings = {
      CLAUDE_MEM_RUNTIME: 'worker',
      CLAUDE_MEM_SERVER_URL: '',
      CLAUDE_MEM_SERVER_API_KEY: '',
      CLAUDE_MEM_SERVER_PROJECT_ID: '',
      CLAUDE_MEM_SERVER_BETA_URL: '',
      CLAUDE_MEM_SERVER_BETA_API_KEY: '',
      CLAUDE_MEM_SERVER_BETA_PROJECT_ID: '',
    };
    warnLogs.length = 0;
  });

  it('selectRuntime defaults to worker', () => {
    expect(selectRuntime()).toBe('worker');
  });

  it("selectRuntime returns 'server' when CLAUDE_MEM_RUNTIME='server' (canonical)", () => {
    mockSettings.CLAUDE_MEM_RUNTIME = 'server';
    expect(selectRuntime()).toBe('server');
  });

  it("selectRuntime returns 'server' when CLAUDE_MEM_RUNTIME='server-beta' (legacy back-compat)", () => {
    mockSettings.CLAUDE_MEM_RUNTIME = 'server-beta';
    expect(selectRuntime()).toBe('server');
  });

  it('selectRuntime returns worker for unknown values', () => {
    mockSettings.CLAUDE_MEM_RUNTIME = 'something-else';
    expect(selectRuntime()).toBe('worker');
  });

  it('selectRuntime accepts mixed case / whitespace', () => {
    mockSettings.CLAUDE_MEM_RUNTIME = '  SERVER  ';
    expect(selectRuntime()).toBe('server');
    mockSettings.CLAUDE_MEM_RUNTIME = '  Server-Beta  ';
    expect(selectRuntime()).toBe('server');
  });

  it('resolveRuntimeContext returns worker when runtime=worker', () => {
    const ctx = resolveRuntimeContext();
    expect(ctx.runtime).toBe('worker');
  });

  it('resolveRuntimeContext falls back to worker when api key is missing', () => {
    mockSettings.CLAUDE_MEM_RUNTIME = 'server';
    mockSettings.CLAUDE_MEM_SERVER_URL = 'http://localhost:1234';
    mockSettings.CLAUDE_MEM_SERVER_PROJECT_ID = 'p1';
    const ctx = resolveRuntimeContext();
    expect(ctx.runtime).toBe('worker');
    expect(warnLogs.some(l => l.msg.includes('missing_api_key'))).toBe(true);
  });

  it("resolveRuntimeContext returns 'server' context when canonical keys are configured", () => {
    mockSettings.CLAUDE_MEM_RUNTIME = 'server';
    mockSettings.CLAUDE_MEM_SERVER_URL = 'http://localhost:1234';
    mockSettings.CLAUDE_MEM_SERVER_API_KEY = 'cmem_xyz';
    mockSettings.CLAUDE_MEM_SERVER_PROJECT_ID = 'project-uuid';
    const ctx = resolveRuntimeContext();
    expect(ctx.runtime).toBe('server');
    if (ctx.runtime === 'server') {
      expect(ctx.projectId).toBe('project-uuid');
      expect(ctx.serverBaseUrl).toBe('http://localhost:1234');
    }
  });

  it("resolveRuntimeContext returns 'server' context when legacy CLAUDE_MEM_RUNTIME='server-beta' + legacy *_BETA_* keys are configured", () => {
    // Simulates an existing installed settings.json from before the rename.
    mockSettings.CLAUDE_MEM_RUNTIME = 'server-beta';
    mockSettings.CLAUDE_MEM_SERVER_BETA_URL = 'http://legacy.example:9999';
    mockSettings.CLAUDE_MEM_SERVER_BETA_API_KEY = 'legacy_key';
    mockSettings.CLAUDE_MEM_SERVER_BETA_PROJECT_ID = 'legacy-project';
    const ctx = resolveRuntimeContext();
    // Canonical runtime literal is `'server'` even for legacy input.
    expect(ctx.runtime).toBe('server');
    if (ctx.runtime === 'server') {
      expect(ctx.projectId).toBe('legacy-project');
      expect(ctx.serverBaseUrl).toBe('http://legacy.example:9999');
    }
  });

  it('buildServerContext prefers new keys when both are set', () => {
    mockSettings.CLAUDE_MEM_SERVER_URL = 'http://new.example:1111';
    mockSettings.CLAUDE_MEM_SERVER_API_KEY = 'new_key';
    mockSettings.CLAUDE_MEM_SERVER_PROJECT_ID = 'new-project';
    mockSettings.CLAUDE_MEM_SERVER_BETA_URL = 'http://old.example:9999';
    mockSettings.CLAUDE_MEM_SERVER_BETA_API_KEY = 'old_key';
    mockSettings.CLAUDE_MEM_SERVER_BETA_PROJECT_ID = 'old-project';
    const ctx = buildServerContext();
    expect(ctx).not.toBeNull();
    if (ctx) {
      expect(ctx.serverBaseUrl).toBe('http://new.example:1111');
      expect(ctx.projectId).toBe('new-project');
    }
  });

  it('buildServerContext falls back to legacy *_BETA_* keys when new keys are unset', () => {
    // No CLAUDE_MEM_SERVER_* keys set, but legacy ones are.
    mockSettings.CLAUDE_MEM_SERVER_BETA_URL = 'http://legacy.example:9999';
    mockSettings.CLAUDE_MEM_SERVER_BETA_API_KEY = 'legacy_key';
    mockSettings.CLAUDE_MEM_SERVER_BETA_PROJECT_ID = 'legacy-project';
    const ctx = buildServerContext();
    expect(ctx).not.toBeNull();
    if (ctx) {
      expect(ctx.serverBaseUrl).toBe('http://legacy.example:9999');
      expect(ctx.projectId).toBe('legacy-project');
      expect(ctx.runtime).toBe('server');
    }
  });

  it('buildServerContext returns null when project id missing on both new and legacy keys', () => {
    mockSettings.CLAUDE_MEM_RUNTIME = 'server';
    mockSettings.CLAUDE_MEM_SERVER_URL = 'http://localhost:1234';
    mockSettings.CLAUDE_MEM_SERVER_API_KEY = 'cmem_xyz';
    expect(buildServerContext()).toBeNull();
    expect(warnLogs.some(l => l.msg.includes('missing_project_id'))).toBe(true);
  });

  it('logServerFallback emits a stable WARN code', () => {
    logServerFallback('transport', { route: '/v1/events' });
    const matched = warnLogs.find(l => l.msg.includes('[server-fallback]'));
    expect(matched).toBeDefined();
    expect(matched?.msg).toContain('reason=transport');
  });

  // #2564 — switching CLAUDE_MEM_RUNTIME flips which runtime hooks dispatch to
  // WITHOUT a reinstall. The selector reads the setting on every call (via
  // loadFromFileOnce), so flipping the setting and re-resolving must change the
  // resolved runtime. This proves the no-reinstall switch end-to-end at the
  // dispatch boundary the hooks use (resolveRuntimeContext).
  // Phase 1d: the persisted literal `'server-beta'` is still accepted in
  // settings, but the selector normalizes it to the canonical `'server'`.
  it('flips worker <-> server when the setting changes (no reinstall)', () => {
    // Start on worker.
    mockSettings.CLAUDE_MEM_RUNTIME = 'worker';
    expect(resolveRuntimeContext().runtime).toBe('worker');

    // Flip to server-beta (fully configured) — hooks now resolve the server runtime.
    // Persisted setting may still be `'server-beta'`; selector normalizes to `'server'`.
    mockSettings.CLAUDE_MEM_RUNTIME = 'server-beta';
    mockSettings.CLAUDE_MEM_SERVER_BETA_URL = 'http://localhost:9999';
    mockSettings.CLAUDE_MEM_SERVER_BETA_API_KEY = 'cmem_flip';
    mockSettings.CLAUDE_MEM_SERVER_BETA_PROJECT_ID = 'proj-flip';
    const flipped = resolveRuntimeContext();
    expect(flipped.runtime).toBe('server');
    if (flipped.runtime === 'server') {
      expect(flipped.serverBaseUrl).toBe('http://localhost:9999');
    }

    // Flip back to worker — hooks resolve the worker runtime again.
    mockSettings.CLAUDE_MEM_RUNTIME = 'worker';
    expect(resolveRuntimeContext().runtime).toBe('worker');
  });
});
