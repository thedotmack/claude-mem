import { describe, it, expect, beforeEach } from 'bun:test';
import { runWorkerDependencyPreflight } from '../../src/services/worker/dependency-preflight.js';
import {
  getDependencyStatus,
  recordDependencyStatus,
  resetDependencyStatusesForTesting,
} from '../../src/shared/dependency-health.js';

function classifier(error: unknown): { kind: string; message: string } {
  return {
    kind: error instanceof Error && /Claude executable not found/.test(error.message)
      ? 'setup_required'
      : 'transient',
    message: error instanceof Error ? error.message : String(error),
  };
}

describe('worker dependency preflight', () => {
  beforeEach(() => {
    resetDependencyStatusesForTesting();
  });

  it('reports a healthy snapshot for a non-Claude provider without checking Claude', () => {
    let claudeChecked = false;

    const snapshot = runWorkerDependencyPreflight({
      settings: {
        CLAUDE_MEM_PROVIDER: 'gemini',
      },
      classifyClaudeError: classifier,
      findClaudeExecutable: () => {
        claudeChecked = true;
        throw new Error('Claude should not be checked for Gemini');
      },
    });

    expect(claudeChecked).toBe(false);
    expect(snapshot.degraded).toBe(false);
    expect(snapshot.statuses).toEqual([]);
  });

  it('clears stale Claude CLI setup status when a non-Claude provider is selected', () => {
    recordDependencyStatus('claude_cli', 'setup_required', 'old failure');

    runWorkerDependencyPreflight({
      settings: {
        CLAUDE_MEM_PROVIDER: 'openrouter',
      },
      classifyClaudeError: classifier,
      findClaudeExecutable: () => {
        throw new Error('Claude should not be checked for OpenRouter');
      },
    });

    expect(getDependencyStatus('claude_cli')).toBeNull();
  });

  it('records Claude CLI setup_required when Claude is selected and discovery fails', () => {
    runWorkerDependencyPreflight({
      settings: {
        CLAUDE_MEM_PROVIDER: 'claude',
      },
      classifyClaudeError: classifier,
      findClaudeExecutable: () => {
        throw new Error('Claude executable not found. Please install Claude Code CLI.');
      },
    });

    expect(getDependencyStatus('claude_cli')).toMatchObject({
      dependency: 'claude_cli',
      kind: 'setup_required',
      message: 'Claude executable not found. Please install Claude Code CLI.',
    });
    expect(getDependencyStatus('claude_cli')?.remediation).toContain('Claude Code CLI');
  });
});
