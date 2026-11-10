import { describe, it, expect } from 'bun:test';
import { claudeCodeAdapter } from '../../src/cli/adapters/claude-code.js';
import type { HookResult } from '../../src/cli/types.js';

describe('Edit 4A — user-message banner relocated to systemMessage (not stderr)', () => {
  it('claude-code adapter routes systemMessage to the stdout JSON envelope (banner reaches the user via contract)', () => {
    const result: HookResult = { systemMessage: 'banner-text', exitCode: 0 };
    const output = claudeCodeAdapter.formatOutput(result) as Record<string, unknown>;
    expect(output.systemMessage).toBe('banner-text');
  });
});
