/**
 * Tests for Claude Code adapter subagent field extraction.
 *
 * Validates that normalizeInput picks up the `agent_id` / `agent_type`
 * fields from Claude Code hook stdin and that the type guard rejects
 * non-string values. These fields are the discriminator for subagent
 * context; they are undefined in main-session payloads.
 *
 * Sources:
 * - Adapter: src/cli/adapters/claude-code.ts
 * - Types:   src/cli/types.ts
 */
import { describe, it, expect } from 'bun:test';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';

describe('claudeCodeAdapter.normalizeInput — subagent fields', () => {
  it('extracts agentId and agentType when both are present', () => {
    const normalized = claudeCodeAdapter.normalizeInput({
      session_id: 's1',
      cwd: '/tmp',
      agent_id: 'agent-abc',
      agent_type: 'Explore',
    });

    expect(normalized.sessionId).toBe('s1');
    expect(normalized.cwd).toBe('/tmp');
    expect(normalized.agentId).toBe('agent-abc');
    expect(normalized.agentType).toBe('Explore');
  });

  it('leaves agentId and agentType undefined when fields are absent (main-session payload)', () => {
    const normalized = claudeCodeAdapter.normalizeInput({
      session_id: 's1',
      cwd: '/tmp',
    });

    expect(normalized.sessionId).toBe('s1');
    expect(normalized.agentId).toBeUndefined();
    expect(normalized.agentType).toBeUndefined();
  });

  it('rejects non-string agent_id via type guard (returns undefined)', () => {
    const normalized = claudeCodeAdapter.normalizeInput({
      session_id: 's1',
      cwd: '/tmp',
      agent_id: 42,
    });

    expect(normalized.agentId).toBeUndefined();
  });

  it('rejects non-string agent_type via type guard (returns undefined)', () => {
    const normalized = claudeCodeAdapter.normalizeInput({
      session_id: 's1',
      cwd: '/tmp',
      agent_type: { kind: 'Explore' },
    });

    expect(normalized.agentType).toBeUndefined();
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

  it('drops agent fields that exceed the 128-char safety cap', () => {
    const oversized = 'a'.repeat(129);
    const normalized = claudeCodeAdapter.normalizeInput({
      session_id: 's1',
      cwd: '/tmp',
      agent_id: oversized,
      agent_type: oversized,
    });

    expect(normalized.agentId).toBeUndefined();
    expect(normalized.agentType).toBeUndefined();
  });

  it('keeps agent fields exactly at the 128-char boundary', () => {
    const atLimit = 'a'.repeat(128);
    const normalized = claudeCodeAdapter.normalizeInput({
      session_id: 's1',
      cwd: '/tmp',
      agent_id: atLimit,
      agent_type: atLimit,
    });

    expect(normalized.agentId).toBe(atLimit);
    expect(normalized.agentType).toBe(atLimit);
  });

  it('drops empty-string agent fields (treat as absent)', () => {
    const normalized = claudeCodeAdapter.normalizeInput({
      session_id: 's1',
      cwd: '/tmp',
      agent_id: '',
      agent_type: '',
    });

    expect(normalized.agentId).toBeUndefined();
    expect(normalized.agentType).toBeUndefined();
  });
});
