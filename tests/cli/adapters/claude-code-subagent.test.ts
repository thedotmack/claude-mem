import { afterAll, beforeEach, describe, it, expect } from 'bun:test';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';
import { AdapterRejectedInput } from '../../../src/cli/adapters/errors.js';

const CLAUDE_PROJECT_DIR_ENV = 'CLAUDE_PROJECT_DIR';
const SDK_TEMP_CWD = '/tmp/sdk-subagent';
const DECLARED_PROJECT_DIR = '/tmp/declared-project';
const NON_STRING_CWD = 42;
const WHITESPACE_CWD = '   ';
const savedClaudeProjectDir = process.env[CLAUDE_PROJECT_DIR_ENV];

beforeEach(() => {
  delete process.env[CLAUDE_PROJECT_DIR_ENV];
});

afterAll(() => {
  if (savedClaudeProjectDir !== undefined) {
    process.env[CLAUDE_PROJECT_DIR_ENV] = savedClaudeProjectDir;
  } else {
    delete process.env[CLAUDE_PROJECT_DIR_ENV];
  }
});

describe('claudeCodeAdapter.normalizeInput — subagent fields', () => {
  it('anchors an SDK subagent cwd to CLAUDE_PROJECT_DIR', () => {
    process.env[CLAUDE_PROJECT_DIR_ENV] = DECLARED_PROJECT_DIR;

    const normalized = claudeCodeAdapter.normalizeInput({
      session_id: 'sdk-session',
      cwd: SDK_TEMP_CWD,
      agent_id: 'sdk-agent',
    });

    expect(normalized.cwd).toBe(DECLARED_PROJECT_DIR);
  });

  it('rejects a non-string cwd with the adapter error contract', () => {
    expect(() => claudeCodeAdapter.normalizeInput({ cwd: NON_STRING_CWD })).toThrow(AdapterRejectedInput);
  });

  it('rejects a whitespace-only cwd once the anchor resolves to nothing', () => {
    // No CLAUDE_PROJECT_DIR, so resolveHookProjectPath() returns null for a
    // blank cwd and the post-resolution isValidCwd guard rejects it.
    expect(() => claudeCodeAdapter.normalizeInput({ cwd: WHITESPACE_CWD })).toThrow(AdapterRejectedInput);
  });

  it.each([
    [undefined, undefined],
    [42, undefined],
    [{}, undefined],
    [{ kind: 'Explore' }, undefined],
    ['', undefined],
    ['a'.repeat(129), undefined],
    ['a'.repeat(128), 'a'.repeat(128)],
    ['agent-only', 'agent-only'],
  ])('normalizes both agent fields from %p', (value, expected) => {
    const normalized = claudeCodeAdapter.normalizeInput({
      session_id: 's1', cwd: process.cwd(), agent_id: value, agent_type: value,
    });
    expect(normalized.agentId).toBe(expected);
    expect(normalized.agentType).toBe(expected);
  });

  it('extracts agentId alone even when agent_type is missing', () => {
    const normalized = claudeCodeAdapter.normalizeInput({
      session_id: 's1',
      cwd: '/tmp',
      agent_id: 'agent-only',
    });

    expect(normalized.agentId).toBe('agent-only');
    expect(normalized.agentType).toBeUndefined();
  });

  it('handles null/undefined raw input gracefully (SessionStart hook)', () => {
    const normalizedNull = claudeCodeAdapter.normalizeInput(null);
    const normalizedUndef = claudeCodeAdapter.normalizeInput(undefined);

    expect(normalizedNull.agentId).toBeUndefined();
    expect(normalizedNull.agentType).toBeUndefined();
    expect(normalizedUndef.agentId).toBeUndefined();
    expect(normalizedUndef.agentType).toBeUndefined();
  });
});
