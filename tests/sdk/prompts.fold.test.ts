import { describe, it, expect } from 'bun:test';
import { buildObservationPrompt } from '../../src/sdk/prompts.js';
import { _resetDedupFoldConfigCache } from '../../src/services/worker/dedup-fold.js';

describe('buildObservationPrompt repetition hint', () => {
  it('does NOT include <repetition> when fold_count is 1 or undefined', () => {
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'Bash',
      tool_input: '{"command":"ls"}',
      tool_output: '{}',
      created_at_epoch: Date.now(),
    });
    expect(prompt).not.toContain('<repetition>');
  });

  it('includes <repetition> when fold_count > 1', () => {
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'Bash',
      tool_input: '{"command":"ls"}',
      tool_output: '{}',
      created_at_epoch: Date.now(),
      fold_count: 5,
    });
    expect(prompt).toContain('<repetition>');
    expect(prompt).toMatch(/repeated 5 times/);
  });
});
