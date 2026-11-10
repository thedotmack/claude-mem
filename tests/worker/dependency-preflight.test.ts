import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'node:path';
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

function run(overrides: Omit<Parameters<typeof runWorkerDependencyPreflight>[0], 'classifyClaudeError'>) {
  return runWorkerDependencyPreflight({
    classifyClaudeError: classifier,
    env: { PATH: '' },
    platform: 'linux',
    homedir: () => '/fixture/home',
    pathExists: () => false,
    isFile: () => false,
    ...overrides,
  });
}

describe('worker dependency preflight', () => {
  beforeEach(() => {
    resetDependencyStatusesForTesting();
  });

  it('records missing uvx using PATH/file checks without checking Claude for Gemini', () => {
    let claudeChecked = false;

    const snapshot = run({
      settings: {
        CLAUDE_MEM_PROVIDER: 'gemini',
        CLAUDE_MEM_CHROMA_ENABLED: 'true',
      },
      findClaudeExecutable: () => {
        claudeChecked = true;
        throw new Error('Claude should not be checked for Gemini');
      },
      env: { PATH: '/tmp/no-uvx' },
    });

    expect(claudeChecked).toBe(false);
    expect(snapshot.degraded).toBe(true);
    expect(getDependencyStatus('uvx')).toMatchObject({
      dependency: 'uvx',
      kind: 'vector_search_unavailable',
    });
    expect(getDependencyStatus('uvx')?.remediation).toContain('uv/uvx');
  });

  it('checks Claude for Gemini when a source maps to claude', () => {
    let claudeChecked = false;

    run({
      settings: {
        CLAUDE_MEM_PROVIDER: 'gemini',
        CLAUDE_MEM_PROVIDER_BY_SOURCE: '{"claude":"claude"}',
        CLAUDE_MEM_CHROMA_ENABLED: 'false',
      },
      findClaudeExecutable: () => {
        claudeChecked = true;
        return '/usr/bin/claude';
      },
      env: { PATH: '/tmp' },
    });

    expect(claudeChecked).toBe(true);
  });

  it('recognizes a Homebrew-only uvx install on darwin', () => {
    let claudeChecked = false;

    const snapshot = run({
      settings: {
        CLAUDE_MEM_PROVIDER: 'gemini',
        CLAUDE_MEM_CHROMA_ENABLED: 'true',
      },
      findClaudeExecutable: () => {
        claudeChecked = true;
        throw new Error('Claude should not be checked for Gemini');
      },
      env: { PATH: '/usr/bin:/bin' },
      platform: 'darwin',
      pathExists: filePath => filePath === '/opt/homebrew/bin',
      isFile: filePath => filePath === path.join('/opt/homebrew/bin', 'uvx'),
    });

    expect(claudeChecked).toBe(false);
    expect(snapshot.degraded).toBe(false);
    expect(getDependencyStatus('uvx')).toBeNull();
  });

  it('finds uvx.exe at the path set in settings on Windows (#4195)', () => {
    const settingsUvx = 'C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Python\\Python313\\Scripts\\uvx.exe';

    const snapshot = run({
      settings: {
        CLAUDE_MEM_PROVIDER: 'gemini',
        CLAUDE_MEM_CHROMA_ENABLED: 'true',
        CLAUDE_MEM_CHROMA_UVX_PATH: settingsUvx,
      },
      env: { PATH: 'C:\\Windows\\System32' },
      platform: 'win32',
      homedir: () => 'C:\\Users\\Jane Doe',
      isFile: filePath => filePath === settingsUvx,
    });

    expect(snapshot.degraded).toBe(false);
    expect(getDependencyStatus('uvx')).toBeNull();
  });

  it('clears stale Claude CLI setup status when a non-Claude provider is selected', () => {
    recordDependencyStatus('claude_cli', 'setup_required', 'old failure');

    run({
      settings: {
        CLAUDE_MEM_PROVIDER: 'openrouter',
        CLAUDE_MEM_CHROMA_ENABLED: 'false',
      },
      findClaudeExecutable: () => {
        throw new Error('Claude should not be checked for OpenRouter');
      },
      env: { PATH: '' },
    });

    expect(getDependencyStatus('claude_cli')).toBeNull();
  });

  it('records Claude CLI setup_required when Claude is selected and discovery fails', () => {
    run({
      settings: {
        CLAUDE_MEM_PROVIDER: 'claude',
        CLAUDE_MEM_CHROMA_ENABLED: 'false',
      },
      findClaudeExecutable: () => {
        throw new Error('Claude executable not found. Please install Claude Code CLI.');
      },
      env: { PATH: '' },
    });

    expect(getDependencyStatus('claude_cli')).toMatchObject({
      dependency: 'claude_cli',
      kind: 'setup_required',
      message: 'Claude executable not found. Please install Claude Code CLI.',
    });
    expect(getDependencyStatus('claude_cli')?.remediation).toContain('Claude Code CLI');
  });
});
