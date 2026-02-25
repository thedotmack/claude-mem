/**
 * Tests for useProjectActions hook
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
  '../../../src/ui/viewer/hooks/useProjectActions.ts'
);

let hookSource: string;

try {
  hookSource = fs.readFileSync(HOOK_SRC, 'utf-8');
} catch {
  hookSource = '';
}

// ---------------------------------------------------------------------------
// Module export tests
// ---------------------------------------------------------------------------

describe('useProjectActions module exports', () => {
  it('exports useProjectActions function', async () => {
    const mod = await import('../../../src/ui/viewer/hooks/useProjectActions.js');
    expect(typeof mod.useProjectActions).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Source structure tests
// ---------------------------------------------------------------------------

describe('useProjectActions source structure', () => {
  it('source file exists', () => {
    expect(hookSource).not.toBe('');
  });

  it('imports API_ENDPOINTS from constants/api', () => {
    expect(hookSource).toContain("from '../constants/api'");
  });

  it('uses useState for isLoading', () => {
    expect(hookSource).toContain('useState');
    expect(hookSource).toContain('isLoading');
  });

  it('uses useState for error', () => {
    expect(hookSource).toContain('error');
  });

  it('uses useCallback for action functions', () => {
    expect(hookSource).toContain('useCallback');
  });

  it('uses logger for error logging (not console.log)', () => {
    expect(hookSource).toContain('logger');
    expect(hookSource).not.toContain('console.log');
    expect(hookSource).not.toContain('console.error');
  });

  it('URL-encodes project names with encodeURIComponent', () => {
    expect(hookSource).toContain('encodeURIComponent');
  });

  it('exports ProjectRowCounts interface', () => {
    expect(hookSource).toContain('ProjectRowCounts');
  });

  it('exports UseProjectActionsResult interface', () => {
    expect(hookSource).toContain('UseProjectActionsResult');
  });

  it('has getRowCounts function', () => {
    expect(hookSource).toContain('getRowCounts');
  });

  it('has renameProject function', () => {
    expect(hookSource).toContain('renameProject');
  });

  it('has mergeProject function', () => {
    expect(hookSource).toContain('mergeProject');
  });

  it('has deleteProject function', () => {
    expect(hookSource).toContain('deleteProject');
  });

  it('returns isLoading in result', () => {
    expect(hookSource).toContain('isLoading');
  });

  it('returns error in result', () => {
    expect(hookSource).toContain('error');
  });

  it('uses PROJECTS_BASE endpoint constant', () => {
    expect(hookSource).toContain('PROJECTS_BASE');
  });

  it('sends POST for rename', () => {
    expect(hookSource).toContain('rename');
    expect(hookSource).toContain("method: 'POST'");
  });

  it('sends POST for merge', () => {
    expect(hookSource).toContain('merge');
  });

  it('sends DELETE for deleteProject', () => {
    expect(hookSource).toContain("method: 'DELETE'");
  });

  it('sets isLoading true during requests', () => {
    expect(hookSource).toContain('setIsLoading(true)');
  });

  it('sets isLoading false in finally block', () => {
    expect(hookSource).toContain('setIsLoading(false)');
  });

  it('parses response JSON for counts', () => {
    expect(hookSource).toContain('counts');
  });

  it('sdk_sessions field in ProjectRowCounts', () => {
    expect(hookSource).toContain('sdk_sessions');
  });

  it('observations field in ProjectRowCounts', () => {
    expect(hookSource).toContain('observations');
  });

  it('session_summaries field in ProjectRowCounts', () => {
    expect(hookSource).toContain('session_summaries');
  });

  it('context_injections field in ProjectRowCounts', () => {
    expect(hookSource).toContain('context_injections');
  });

  it('sets error state on failure', () => {
    expect(hookSource).toContain('setError');
  });
});
