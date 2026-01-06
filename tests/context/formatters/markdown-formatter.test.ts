import { describe, it, expect, mock, beforeEach } from 'bun:test';

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
        const icons: Record<string, string> = {
          decision: 'D',
          bugfix: 'B',
          discovery: 'I',
        };
        return icons[type] || '?';
      },
      getWorkEmoji: () => 'W',
    }),
  },
}));

import {
  renderMarkdownHeader,
  renderMarkdownLegend,
  renderMarkdownColumnKey,
  renderMarkdownContextIndex,
  renderMarkdownContextEconomics,
  renderMarkdownDayHeader,
  renderMarkdownFileHeader,
  renderMarkdownTableRow,
  renderMarkdownFullObservation,
  renderMarkdownSummaryItem,
  renderMarkdownSummaryField,
  renderMarkdownPreviouslySection,
  renderMarkdownFooter,
  renderMarkdownEmptyState,
} from '../../../src/services/context/formatters/MarkdownFormatter.js';

import type { Observation, TokenEconomics, ContextConfig, PriorMessages } from '../../../src/services/context/types.js';

// Helper to create a minimal observation
function createTestObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 1,
    memory_session_id: 'session-123',
    type: 'discovery',
    title: 'Test Observation',
    subtitle: null,
    narrative: 'A test narrative',
    facts: '["fact1"]',
    concepts: '["concept1"]',
    files_read: null,
    files_modified: null,
    discovery_tokens: 100,
    created_at: '2025-01-01T12:00:00.000Z',
    created_at_epoch: 1735732800000,
    ...overrides,
  };
}

// Helper to create token economics
function createTestEconomics(overrides: Partial<TokenEconomics> = {}): TokenEconomics {
  return {
    totalObservations: 10,
    totalReadTokens: 500,
    totalDiscoveryTokens: 5000,
    savings: 4500,
    savingsPercent: 90,
    ...overrides,
  };
}

// Helper to create context config
function createTestConfig(overrides: Partial<ContextConfig> = {}): ContextConfig {
  return {
    totalObservationCount: 50,
    fullObservationCount: 5,
    sessionCount: 3,
    showReadTokens: true,
    showWorkTokens: true,
    showSavingsAmount: true,
    showSavingsPercent: true,
    observationTypes: new Set(['discovery', 'decision', 'bugfix']),
    observationConcepts: new Set(['concept1', 'concept2']),
    fullObservationField: 'narrative',
    showLastSummary: true,
    showLastMessage: true,
    ...overrides,
  };
}

describe('MarkdownFormatter', () => {
  describe('renderMarkdownHeader', () => {
    it('should produce valid markdown header with project name', () => {
      const result = renderMarkdownHeader('my-project');

      expect(result).toHaveLength(2);
      expect(result[0]).toMatch(/^# \[my-project\] recent context, \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}[ap]m [A-Z]{3,4}$/);
      expect(result[1]).toBe('');
    });

    it('should handle special characters in project name', () => {
      const result = renderMarkdownHeader('project-with-special_chars.v2');

      expect(result[0]).toContain('project-with-special_chars.v2');
    });

    it('should handle empty project name', () => {
      const result = renderMarkdownHeader('');

      expect(result[0]).toMatch(/^# \[\] recent context, \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}[ap]m [A-Z]{3,4}$/);
    });
  });

  describe('renderMarkdownLegend', () => {
    it('should produce legend with type items', () => {
      const result = renderMarkdownLegend();

      expect(result).toHaveLength(2);
      expect(result[0]).toContain('**Legend:**');
      expect(result[1]).toBe('');
    });

    it('should include session-request in legend', () => {
      const result = renderMarkdownLegend();

      expect(result[0]).toContain('session-request');
    });
  });

  describe('renderMarkdownColumnKey', () => {
    it('should produce column key explanation', () => {
      const result = renderMarkdownColumnKey();

      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('**Column Key**');
    });

    it('should explain Read column', () => {
      const result = renderMarkdownColumnKey();
      const joined = result.join('\n');

      expect(joined).toContain('Read');
      expect(joined).toContain('Tokens to read');
    });

    it('should explain Work column', () => {
      const result = renderMarkdownColumnKey();
      const joined = result.join('\n');

      expect(joined).toContain('Work');
      expect(joined).toContain('Tokens spent');
    });
  });

  describe('renderMarkdownContextIndex', () => {
    it('should produce context index instructions', () => {
      const result = renderMarkdownContextIndex();

      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('**Context Index:**');
    });

    it('should mention MCP tools', () => {
      const result = renderMarkdownContextIndex();
      const joined = result.join('\n');

      expect(joined).toContain('MCP tools');
    });
  });

  describe('renderMarkdownContextEconomics', () => {
    it('should include observation count', () => {
      const economics = createTestEconomics({ totalObservations: 25 });
      const config = createTestConfig();

      const result = renderMarkdownContextEconomics(economics, config);
      const joined = result.join('\n');

      expect(joined).toContain('25 observations');
    });

    it('should include read tokens', () => {
      const economics = createTestEconomics({ totalReadTokens: 1500 });
      const config = createTestConfig();

      const result = renderMarkdownContextEconomics(economics, config);
      const joined = result.join('\n');

      expect(joined).toContain('1,500 tokens');
    });

    it('should include work investment', () => {
      const economics = createTestEconomics({ totalDiscoveryTokens: 10000 });
      const config = createTestConfig();

      const result = renderMarkdownContextEconomics(economics, config);
      const joined = result.join('\n');

      expect(joined).toContain('10,000 tokens');
    });

    it('should show savings when config has showSavingsAmount', () => {
      const economics = createTestEconomics({ savings: 4500, savingsPercent: 90, totalDiscoveryTokens: 5000 });
      const config = createTestConfig({ showSavingsAmount: true, showSavingsPercent: false });

      const result = renderMarkdownContextEconomics(economics, config);
      const joined = result.join('\n');

      expect(joined).toContain('savings');
      expect(joined).toContain('4,500 tokens');
    });

    it('should show savings percent when config has showSavingsPercent', () => {
      const economics = createTestEconomics({ savingsPercent: 85, totalDiscoveryTokens: 1000 });
      const config = createTestConfig({ showSavingsAmount: false, showSavingsPercent: true });

      const result = renderMarkdownContextEconomics(economics, config);
      const joined = result.join('\n');

      expect(joined).toContain('85%');
    });

    it('should not show savings when discovery tokens is 0', () => {
      const economics = createTestEconomics({ totalDiscoveryTokens: 0, savings: 0, savingsPercent: 0 });
      const config = createTestConfig({ showSavingsAmount: true, showSavingsPercent: true });

      const result = renderMarkdownContextEconomics(economics, config);
      const joined = result.join('\n');

      expect(joined).not.toContain('Your savings');
    });
  });

  describe('renderMarkdownDayHeader', () => {
    it('should render day as h3 heading', () => {
      const result = renderMarkdownDayHeader('2025-01-01');

      expect(result).toHaveLength(2);
      expect(result[0]).toBe('### 2025-01-01');
      expect(result[1]).toBe('');
    });
  });

  describe('renderMarkdownFileHeader', () => {
    it('should render file name in bold', () => {
      const result = renderMarkdownFileHeader('src/index.ts');

      expect(result[0]).toBe('**src/index.ts**');
    });

    it('should include table headers', () => {
      const result = renderMarkdownFileHeader('test.ts');
      const joined = result.join('\n');

      expect(joined).toContain('| ID |');
      expect(joined).toContain('| Time |');
      expect(joined).toContain('| T |');
      expect(joined).toContain('| Title |');
      expect(joined).toContain('| Read |');
      expect(joined).toContain('| Work |');
    });

    it('should include separator row', () => {
      const result = renderMarkdownFileHeader('test.ts');

      expect(result[2]).toContain('|----');
    });
  });

  describe('renderMarkdownTableRow', () => {
    it('should include observation ID with hash prefix', () => {
      const obs = createTestObservation({ id: 42 });
      const config = createTestConfig();

      const result = renderMarkdownTableRow(obs, '10:30', config);

      expect(result).toContain('#42');
    });

    it('should include time display', () => {
      const obs = createTestObservation();
      const config = createTestConfig();

      const result = renderMarkdownTableRow(obs, '14:30', config);

      expect(result).toContain('14:30');
    });

    it('should include title', () => {
      const obs = createTestObservation({ title: 'Important Discovery' });
      const config = createTestConfig();

      const result = renderMarkdownTableRow(obs, '10:00', config);

      expect(result).toContain('Important Discovery');
    });

    it('should use "Untitled" when title is null', () => {
      const obs = createTestObservation({ title: null });
      const config = createTestConfig();

      const result = renderMarkdownTableRow(obs, '10:00', config);

      expect(result).toContain('Untitled');
    });

    it('should show read tokens when config enabled', () => {
      const obs = createTestObservation();
      const config = createTestConfig({ showReadTokens: true });

      const result = renderMarkdownTableRow(obs, '10:00', config);

      expect(result).toContain('~');
    });

    it('should hide read tokens when config disabled', () => {
      const obs = createTestObservation();
      const config = createTestConfig({ showReadTokens: false });

      const result = renderMarkdownTableRow(obs, '10:00', config);

      // Row should have empty read column
      const columns = result.split('|');
      // Find the Read column (5th column, index 5)
      expect(columns[5].trim()).toBe('');
    });

    it('should use quote mark for repeated time', () => {
      const obs = createTestObservation();
      const config = createTestConfig();

      // Empty string timeDisplay means "same as previous"
      const result = renderMarkdownTableRow(obs, '', config);

      expect(result).toContain('"');
    });
  });

  describe('renderMarkdownFullObservation', () => {
    it('should include observation ID and title', () => {
      const obs = createTestObservation({ id: 7, title: 'Full Observation' });
      const config = createTestConfig();

      const result = renderMarkdownFullObservation(obs, '10:00', 'Detail content', config);
      const joined = result.join('\n');

      expect(joined).toContain('**#7**');
      expect(joined).toContain('**Full Observation**');
    });

    it('should include detail field when provided', () => {
      const obs = createTestObservation();
      const config = createTestConfig();

      const result = renderMarkdownFullObservation(obs, '10:00', 'The detailed narrative here', config);
      const joined = result.join('\n');

      expect(joined).toContain('The detailed narrative here');
    });

    it('should not include detail field when null', () => {
      const obs = createTestObservation();
      const config = createTestConfig();

      const result = renderMarkdownFullObservation(obs, '10:00', null, config);

      // Should not have an extra content block
      expect(result.length).toBeLessThan(5);
    });

    it('should include token info when enabled', () => {
      const obs = createTestObservation({ discovery_tokens: 250 });
      const config = createTestConfig({ showReadTokens: true, showWorkTokens: true });

      const result = renderMarkdownFullObservation(obs, '10:00', null, config);
      const joined = result.join('\n');

      expect(joined).toContain('Read:');
      expect(joined).toContain('Work:');
    });
  });

  describe('renderMarkdownSummaryItem', () => {
    it('should include session ID with S prefix', () => {
      const summary = { id: 5, request: 'Implement feature' };

      const result = renderMarkdownSummaryItem(summary, '2025-01-01 10:00');
      const joined = result.join('\n');

      expect(joined).toContain('**#S5**');
    });

    it('should include request text', () => {
      const summary = { id: 1, request: 'Build authentication' };

      const result = renderMarkdownSummaryItem(summary, '10:00');
      const joined = result.join('\n');

      expect(joined).toContain('Build authentication');
    });

    it('should use "Session started" when request is null', () => {
      const summary = { id: 1, request: null };

      const result = renderMarkdownSummaryItem(summary, '10:00');
      const joined = result.join('\n');

      expect(joined).toContain('Session started');
    });
  });

  describe('renderMarkdownSummaryField', () => {
    it('should render label and value in bold', () => {
      const result = renderMarkdownSummaryField('Learned', 'How to test');

      expect(result).toHaveLength(2);
      expect(result[0]).toBe('**Learned**: How to test');
      expect(result[1]).toBe('');
    });

    it('should return empty array when value is null', () => {
      const result = renderMarkdownSummaryField('Learned', null);

      expect(result).toHaveLength(0);
    });

    it('should return empty array when value is empty string', () => {
      const result = renderMarkdownSummaryField('Learned', '');

      // Empty string is falsy, so should return empty array
      expect(result).toHaveLength(0);
    });
  });

  describe('renderMarkdownPreviouslySection', () => {
    it('should render section when assistantMessage exists', () => {
      const priorMessages: PriorMessages = {
        userMessage: '',
        assistantMessage: 'I completed the task successfully.',
      };

      const result = renderMarkdownPreviouslySection(priorMessages);
      const joined = result.join('\n');

      expect(joined).toContain('**Previously**');
      expect(joined).toContain('A: I completed the task successfully.');
    });

    it('should return empty when assistantMessage is empty', () => {
      const priorMessages: PriorMessages = {
        userMessage: '',
        assistantMessage: '',
      };

      const result = renderMarkdownPreviouslySection(priorMessages);

      expect(result).toHaveLength(0);
    });

    it('should include separator', () => {
      const priorMessages: PriorMessages = {
        userMessage: '',
        assistantMessage: 'Some message',
      };

      const result = renderMarkdownPreviouslySection(priorMessages);
      const joined = result.join('\n');

      expect(joined).toContain('---');
    });
  });

  describe('renderMarkdownFooter', () => {
    it('should include token amounts', () => {
      const result = renderMarkdownFooter(10000, 500);
      const joined = result.join('\n');

      expect(joined).toContain('10k');
      expect(joined).toContain('500');
    });

    it('should mention MCP', () => {
      const result = renderMarkdownFooter(5000, 100);
      const joined = result.join('\n');

      expect(joined).toContain('MCP');
    });

    it('should round work tokens to nearest thousand', () => {
      const result = renderMarkdownFooter(15500, 100);
      const joined = result.join('\n');

      // 15500 / 1000 = 15.5 -> rounds to 16
      expect(joined).toContain('16k');
    });
  });

  describe('renderMarkdownEmptyState', () => {
    it('should return helpful message with project name', () => {
      const result = renderMarkdownEmptyState('my-project');

      expect(result).toContain('# [my-project] recent context');
      expect(result).toContain('No previous sessions found');
    });

    it('should be valid markdown', () => {
      const result = renderMarkdownEmptyState('test');

      // Should start with h1
      expect(result.startsWith('#')).toBe(true);
    });

    it('should handle empty project name', () => {
      const result = renderMarkdownEmptyState('');

      expect(result).toContain('# [] recent context');
    });
  });
});
