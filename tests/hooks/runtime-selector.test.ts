// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, mock, beforeEach } from 'bun:test';

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
});
