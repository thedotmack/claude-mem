import { describe, expect, it } from 'bun:test';
import { describeProviderAuthMethod } from '../../src/services/worker/provider-status.js';

describe('describeProviderAuthMethod', () => {
  it('reports Codex auth as local Codex CLI login', () => {
    expect(describeProviderAuthMethod('codex', 'Claude Code OAuth token')).toBe('Codex CLI login');
  });

  it('keeps the Claude auth description for the Claude provider', () => {
    expect(describeProviderAuthMethod('claude', 'Claude Code OAuth token')).toBe('Claude Code OAuth token');
  });
});
