import { describe, expect, it } from 'bun:test';
import { claudeCodeAdapter, getPlatformAdapter } from '../../../src/cli/adapters/index.js';

describe('getPlatformAdapter aliases', () => {
  it('routes claude to the Claude Code adapter', () => {
    expect(getPlatformAdapter('claude')).toBe(claudeCodeAdapter);
    expect(getPlatformAdapter('claude-code')).toBe(claudeCodeAdapter);
  });
});
