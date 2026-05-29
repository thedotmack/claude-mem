// SPDX-License-Identifier: Apache-2.0
//
// #2572 — wrong-runtime guard for the server-beta operability CLI.
// #2554 — stale DEFAULT_MODEL fix.

import { describe, expect, it } from 'bun:test';
import { assertServerRuntimeForCli } from '../../src/server/runtime/ServerBetaService.js';
import { DEFAULT_SERVER_CLAUDE_MODEL } from '../../src/server/generation/providers/ClaudeObservationProvider.js';

describe('assertServerRuntimeForCli — wrong-runtime guard (#2572)', () => {
  it('passes for server-beta runtime with a database URL', () => {
    expect(() =>
      assertServerRuntimeForCli('keys', {
        CLAUDE_MEM_RUNTIME: 'server-beta',
        CLAUDE_MEM_SERVER_DATABASE_URL: 'postgres://localhost/db',
      }),
    ).not.toThrow();
  });

  it('passes when runtime is unset but a database URL is present (bare server image)', () => {
    expect(() =>
      assertServerRuntimeForCli('jobs', {
        CLAUDE_MEM_SERVER_DATABASE_URL: 'postgres://localhost/db',
      }),
    ).not.toThrow();
  });

  it('fails CLEARLY when run in a worker-only runtime context', () => {
    expect(() =>
      assertServerRuntimeForCli('keys', {
        CLAUDE_MEM_RUNTIME: 'worker',
        CLAUDE_MEM_SERVER_DATABASE_URL: 'postgres://localhost/db',
      }),
    ).toThrow(/server-beta runtime command.*CLAUDE_MEM_RUNTIME=worker/s);
  });

  it('fails CLEARLY (actionable) when no database URL is configured', () => {
    expect(() =>
      assertServerRuntimeForCli('jobs', { CLAUDE_MEM_RUNTIME: 'server-beta' }),
    ).toThrow(/CLAUDE_MEM_SERVER_DATABASE_URL is required/);
  });
});

describe('Claude provider default model (#2554)', () => {
  it('uses a current, valid model id (not the stale claude-3-5-sonnet-latest)', () => {
    expect(DEFAULT_SERVER_CLAUDE_MODEL).toBe('claude-sonnet-4-6');
    expect(DEFAULT_SERVER_CLAUDE_MODEL).not.toBe('claude-3-5-sonnet-latest');
  });
});
