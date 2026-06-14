import { describe, expect, it } from 'bun:test';

import { formatMessage } from '../../src/services/integrations/TelegramNotifier.js';
import type { ParsedObservation } from '../../src/sdk/parser.js';

function observation(overrides: Partial<ParsedObservation> = {}): ParsedObservation {
  return {
    type: 'discovery',
    title: 'Claude Code Session',
    subtitle: 'Generated from a Codex run',
    facts: [],
    narrative: null,
    concepts: [],
    files_read: [],
    files_modified: [],
    ...overrides,
  };
}

describe('TelegramNotifier', () => {
  it('renames generic Claude session titles for Codex-sourced observations', () => {
    const message = formatMessage(observation(), 'claude-mem', 'mem-1', 123, 'codex');

    expect(message).toContain('Codex Session');
    expect(message).not.toContain('Claude Code Session');
  });

  it('renames generic Claude session labels anywhere in Codex Telegram display text', () => {
    const message = formatMessage(
      observation({
        title: 'Follow-up from Claude Code Session',
        subtitle: 'Claude Code Session generated a Codex observation',
      }),
      'claude-mem',
      'mem-1',
      123,
      'codex',
    );

    expect(message).toContain('Follow\\-up from Codex Session');
    expect(message).toContain('Codex Session generated a Codex observation');
    expect(message).not.toContain('Claude Code Session');
  });

  it('preserves Claude session titles for Claude-sourced observations', () => {
    const message = formatMessage(observation(), 'claude-mem', 'mem-1', 123, 'claude');

    expect(message).toContain('Claude Code Session');
  });
});
