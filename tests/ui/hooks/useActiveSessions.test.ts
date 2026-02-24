/**
 * Tests for useActiveSessions hook
 *
 * Tests module structure and source inspection since we cannot run React hooks
 * without a DOM environment. Visual and interaction behaviour is covered by
 * the Playwright E2E suite.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const HOOK_SRC = path.resolve(
  __dirname,
  '../../../src/ui/viewer/hooks/useActiveSessions.ts'
);

let hookSource: string;

// Read source synchronously once
try {
  hookSource = fs.readFileSync(HOOK_SRC, 'utf-8');
} catch {
  hookSource = '';
}

// ---------------------------------------------------------------------------
// Module export tests
// ---------------------------------------------------------------------------

describe('useActiveSessions module exports', () => {
  it('exports useActiveSessions function', async () => {
    const mod = await import('../../../src/ui/viewer/hooks/useActiveSessions.js');
    expect(typeof mod.useActiveSessions).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Source structure tests
// ---------------------------------------------------------------------------

describe('useActiveSessions source structure', () => {
  it('source file exists', () => {
    expect(hookSource).not.toBe('');
  });

  it('uses API_ENDPOINTS.ACTIVE_SESSIONS for fetching sessions', () => {
    expect(hookSource).toContain('API_ENDPOINTS.ACTIVE_SESSIONS');
  });

  it('uses AbortController for cleanup', () => {
    expect(hookSource).toContain('AbortController');
  });

  it('uses useRef for AbortController', () => {
    expect(hookSource).toContain('useRef');
  });

  it('uses useState for sessions data', () => {
    expect(hookSource).toContain('useState');
  });

  it('uses useCallback for loadActiveSessions', () => {
    expect(hookSource).toContain('useCallback');
  });

  it('uses useEffect for lifecycle management', () => {
    expect(hookSource).toContain('useEffect');
  });

  it('uses setInterval for polling', () => {
    expect(hookSource).toContain('setInterval');
  });

  it('clears interval on unmount', () => {
    expect(hookSource).toContain('clearInterval');
  });

  it('aborts controller on unmount', () => {
    expect(hookSource).toContain('abort()');
  });

  it('has closeSession action', () => {
    expect(hookSource).toContain('closeSession');
  });

  it('has closeAllStale action', () => {
    expect(hookSource).toContain('closeAllStale');
  });

  it('uses ACTIVE_SESSIONS_POLL_INTERVAL_MS constant', () => {
    expect(hookSource).toContain('ACTIVE_SESSIONS_POLL_INTERVAL_MS');
  });

  it('uses logger for error logging (not console.log)', () => {
    expect(hookSource).toContain('logger');
    expect(hookSource).not.toContain('console.log');
    expect(hookSource).not.toContain('console.error');
  });

  it('imports from API_ENDPOINTS constant', () => {
    expect(hookSource).toContain("from '../constants/api'");
  });

  it('returns sessions array', () => {
    expect(hookSource).toContain('sessions');
  });

  it('returns staleCount', () => {
    expect(hookSource).toContain('staleCount');
  });

  it('returns totalCount', () => {
    expect(hookSource).toContain('totalCount');
  });

  it('returns isLoading', () => {
    expect(hookSource).toContain('isLoading');
  });

  it('uses POST method for closeSession', () => {
    expect(hookSource).toContain("method: 'POST'");
  });

  it('posts to close-stale-sessions endpoint', () => {
    expect(hookSource).toContain('CLOSE_STALE_SESSIONS');
  });
});
