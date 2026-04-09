import { describe, it, expect, mock } from 'bun:test';

// Mock the ModeManager before importing the formatter
mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [
          { id: 'decision', emoji: 'D' },
          { id: 'bugfix', emoji: 'B' },
          { id: 'discovery', emoji: 'I' },
        ],
        observation_concepts: [],
      }),
      getTypeIcon: (type: string) => {
        const icons: Record<string, string> = { decision: 'D', bugfix: 'B', discovery: 'I' };
        return icons[type] || '?';
      },
      getWorkEmoji: () => 'W',
    }),
  },
}));

import {
  renderColorFooter,
} from '../../../src/services/context/formatters/ColorFormatter.js';

describe('renderColorFooter', () => {
  it('should include token amounts', () => {
    const result = renderColorFooter(10000, 500);
    const joined = result.join('\n');

    expect(joined).toContain('10k');
    expect(joined).toContain('500');
  });

  it('should mention claude-mem skill', () => {
    const result = renderColorFooter(5000, 100);
    const joined = result.join('\n');

    expect(joined).toContain('claude-mem');
  });

  it('should clarify observation ID to avoid confusion with user_prompts IDs (#1339)', () => {
    const result = renderColorFooter(5000, 100);
    const joined = result.join('\n');

    // Must say "observation ID" to distinguish from user_prompts/session_summaries IDs
    expect(joined).toContain('observation ID');
  });
});
