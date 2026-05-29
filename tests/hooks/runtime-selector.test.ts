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
  buildServerBetaContext,
  logServerBetaFallback,
} from '../../src/services/hooks/runtime-selector.js';

describe('runtime-selector', () => {
  beforeEach(() => {
    mockSettings = {
      CLAUDE_MEM_RUNTIME: 'worker',
      CLAUDE_MEM_SERVER_BETA_URL: '',
      CLAUDE_MEM_SERVER_BETA_API_KEY: '',
      CLAUDE_MEM_SERVER_BETA_PROJECT_ID: '',
    };
    warnLogs.length = 0;
  });

  it('selectRuntime defaults to worker', () => {
    expect(selectRuntime()).toBe('worker');
  });

  it('selectRuntime returns server-beta when settings say so', () => {
    mockSettings.CLAUDE_MEM_RUNTIME = 'server-beta';
    expect(selectRuntime()).toBe('server-beta');
  });

  it('resolveRuntimeContext returns worker when runtime=worker', () => {
    const ctx = resolveRuntimeContext();
    expect(ctx.runtime).toBe('worker');
  });

  it('resolveRuntimeContext falls back to worker when api key is missing', () => {
    mockSettings.CLAUDE_MEM_RUNTIME = 'server-beta';
    mockSettings.CLAUDE_MEM_SERVER_BETA_URL = 'http://localhost:1234';
    mockSettings.CLAUDE_MEM_SERVER_BETA_PROJECT_ID = 'p1';
    const ctx = resolveRuntimeContext();
    expect(ctx.runtime).toBe('worker');
    expect(warnLogs.some(l => l.msg.includes('missing_api_key'))).toBe(true);
  });

  it('resolveRuntimeContext returns server-beta context when fully configured', () => {
    mockSettings.CLAUDE_MEM_RUNTIME = 'server-beta';
    mockSettings.CLAUDE_MEM_SERVER_BETA_URL = 'http://localhost:1234';
    mockSettings.CLAUDE_MEM_SERVER_BETA_API_KEY = 'cmem_xyz';
    mockSettings.CLAUDE_MEM_SERVER_BETA_PROJECT_ID = 'project-uuid';
    const ctx = resolveRuntimeContext();
    expect(ctx.runtime).toBe('server-beta');
    if (ctx.runtime === 'server-beta') {
      expect(ctx.projectId).toBe('project-uuid');
      expect(ctx.serverBaseUrl).toBe('http://localhost:1234');
    }
  });

  it('buildServerBetaContext returns null when project id missing', () => {
    mockSettings.CLAUDE_MEM_RUNTIME = 'server-beta';
    mockSettings.CLAUDE_MEM_SERVER_BETA_URL = 'http://localhost:1234';
    mockSettings.CLAUDE_MEM_SERVER_BETA_API_KEY = 'cmem_xyz';
    expect(buildServerBetaContext()).toBeNull();
    expect(warnLogs.some(l => l.msg.includes('missing_project_id'))).toBe(true);
  });

  it('logServerBetaFallback emits a stable WARN code', () => {
    logServerBetaFallback('transport', { route: '/v1/events' });
    const matched = warnLogs.find(l => l.msg.includes('[server-beta-fallback]'));
    expect(matched).toBeDefined();
    expect(matched?.msg).toContain('reason=transport');
  });

  // #2564 — switching CLAUDE_MEM_RUNTIME flips which runtime hooks dispatch to
  // WITHOUT a reinstall. The selector reads the setting on every call (via
  // loadFromFileOnce), so flipping the setting and re-resolving must change the
  // resolved runtime. This proves the no-reinstall switch end-to-end at the
  // dispatch boundary the hooks use (resolveRuntimeContext).
  it('flips worker <-> server-beta when the setting changes (no reinstall)', () => {
    // Start on worker.
    mockSettings.CLAUDE_MEM_RUNTIME = 'worker';
    expect(resolveRuntimeContext().runtime).toBe('worker');

    // Flip to server-beta (fully configured) — hooks now resolve the server runtime.
    mockSettings.CLAUDE_MEM_RUNTIME = 'server-beta';
    mockSettings.CLAUDE_MEM_SERVER_BETA_URL = 'http://localhost:9999';
    mockSettings.CLAUDE_MEM_SERVER_BETA_API_KEY = 'cmem_flip';
    mockSettings.CLAUDE_MEM_SERVER_BETA_PROJECT_ID = 'proj-flip';
    const flipped = resolveRuntimeContext();
    expect(flipped.runtime).toBe('server-beta');
    if (flipped.runtime === 'server-beta') {
      expect(flipped.serverBaseUrl).toBe('http://localhost:9999');
    }

    // Flip back to worker — hooks resolve the worker runtime again.
    mockSettings.CLAUDE_MEM_RUNTIME = 'worker';
    expect(resolveRuntimeContext().runtime).toBe('worker');
  });
});
