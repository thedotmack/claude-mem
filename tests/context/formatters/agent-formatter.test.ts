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
  renderAgentHeader,
  renderAgentLegend,
  renderAgentColumnKey,
  renderAgentContextIndex,
  renderAgentContextEconomics,
  renderAgentDayHeader,
  renderAgentFileHeader,
  renderAgentTableRow,
  renderAgentFullObservation,
  renderAgentSummaryItem,
  renderAgentSummaryField,
  renderAgentPreviouslySection,
  renderAgentFooter,
  renderAgentEmptyState,
} from '../../../src/services/context/formatters/AgentFormatter.js';

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

describe('AgentFormatter', () => {
  describe('renderAgentHeader', () => {
    it('should produce valid markdown header with project name', () => {
      const result = renderAgentHeader('my-project');

      expect(result).toHaveLength(2);
      expect(result[0]).toMatch(/^# \[my-project\] recent context, \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}[ap]m [A-Z]{3,4}$/);
      expect(result[1]).toBe('');
    });

    it('should handle special characters in project name', () => {
      const result = renderAgentHeader('project-with-special_chars.v2');

      expect(result[0]).toContain('project-with-special_chars.v2');
    });

    it('should handle empty project name', () => {
      const result = renderAgentHeader('');

      expect(result[0]).toMatch(/^# \[\] recent context, \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}[ap]m [A-Z]{3,4}$/);
    });
  });

  describe('renderAgentLegend', () => {
    it('should produce legend with type items', () => {
      const result = renderAgentLegend();

      expect(result).toHaveLength(4);
      expect(result[0]).toContain('Legend:');
      expect(result[3]).toBe('');
    });

    it('should include session in legend', () => {
      const result = renderAgentLegend();

      expect(result[0]).toContain('session');
    });
  });

  describe('renderAgentColumnKey', () => {
    it('should return empty array in compact format', () => {
      const result = renderAgentColumnKey();

      expect(result).toHaveLength(0);
    });
  });

  describe('renderAgentContextIndex', () => {
    it('should return empty array in compact format', () => {
      const result = renderAgentContextIndex();

      expect(result).toHaveLength(0);
    });
  });

  describe('renderAgentContextEconomics', () => {
    it('should include observation count', () => {
      const economics = createTestEconomics({ totalObservations: 25 });
      const config = createTestConfig();

      const result = renderAgentContextEconomics(economics, config);
      const joined = result.join('\n');

      expect(joined).toContain('25 obs');
    });

    it('should include read tokens', () => {
      const economics = createTestEconomics({ totalReadTokens: 1500 });
      const config = createTestConfig();

      const result = renderAgentContextEconomics(economics, config);
      const joined = result.join('\n');

      expect(joined).toContain('1,500t read');
    });

    it('should include work investment', () => {
      const economics = createTestEconomics({ totalDiscoveryTokens: 10000 });
      const config = createTestConfig();

      const result = renderAgentContextEconomics(economics, config);
      const joined = result.join('\n');

      expect(joined).toContain('10,000t work');
    });

    it('should show savings when config has showSavingsAmount', () => {
      const economics = createTestEconomics({ savings: 4500, savingsPercent: 90, totalDiscoveryTokens: 5000 });
      const config = createTestConfig({ showSavingsAmount: true, showSavingsPercent: false });

      const result = renderAgentContextEconomics(economics, config);
      const joined = result.join('\n');

      expect(joined).toContain('4,500t saved');
    });

    it('should show savings percent when config has showSavingsPercent', () => {
      const economics = createTestEconomics({ savingsPercent: 85, totalDiscoveryTokens: 1000 });
      const config = createTestConfig({ showSavingsAmount: false, showSavingsPercent: true });

      const result = renderAgentContextEconomics(economics, config);
      const joined = result.join('\n');

      expect(joined).toContain('85% savings');
    });

    it('should not show savings when discovery tokens is 0', () => {
      const economics = createTestEconomics({ totalDiscoveryTokens: 0, savings: 0, savingsPercent: 0 });
      const config = createTestConfig({ showSavingsAmount: true, showSavingsPercent: true });

      const result = renderAgentContextEconomics(economics, config);
      const joined = result.join('\n');

      expect(joined).not.toContain('savings');
    });
  });

  describe('renderAgentDayHeader', () => {
    it('should render day as h3 heading', () => {
      const result = renderAgentDayHeader('2025-01-01');

      expect(result).toHaveLength(1);
      expect(result[0]).toBe('### 2025-01-01');
    });
  });

  describe('renderAgentFileHeader', () => {
    it('should return empty array in compact format', () => {
      const result = renderAgentFileHeader('src/index.ts');

      expect(result).toHaveLength(0);
    });
  });

  describe('renderAgentTableRow', () => {
    it('should include observation ID', () => {
      const obs = createTestObservation({ id: 42 });
      const config = createTestConfig();

      const result = renderAgentTableRow(obs, '10:30 AM', config);

      expect(result).toContain('42');
    });

    it('should include compact time display', () => {
      const obs = createTestObservation();
      const config = createTestConfig();

      const result = renderAgentTableRow(obs, '2:30 PM', config);

      expect(result).toContain('2:30p');
    });

    it('should include title', () => {
      const obs = createTestObservation({ title: 'Important Discovery' });
      const config = createTestConfig();

      const result = renderAgentTableRow(obs, '10:00 AM', config);

      expect(result).toContain('Important Discovery');
    });

    it('should use "Untitled" when title is null', () => {
      const obs = createTestObservation({ title: null });
      const config = createTestConfig();

      const result = renderAgentTableRow(obs, '10:00 AM', config);

      expect(result).toContain('Untitled');
    });

    it('should produce flat format: ID TIME TYPE TITLE', () => {
      const obs = createTestObservation({ id: 5 });
      const config = createTestConfig();

      const result = renderAgentTableRow(obs, '10:00 AM', config);

      expect(result).toBe('5 10:00a I Test Observation');
    });

    it('should use quote mark for repeated time', () => {
      const obs = createTestObservation();
      const config = createTestConfig();

      // Empty string timeDisplay means "same as previous"
      const result = renderAgentTableRow(obs, '', config);

      expect(result).toContain('"');
    });
  });

  describe('renderAgentFullObservation', () => {
    it('should include observation ID and title', () => {
      const obs = createTestObservation({ id: 7, title: 'Full Observation' });
      const config = createTestConfig();

      const result = renderAgentFullObservation(obs, '10:00 AM', 'Detail content', config);
      const joined = result.join('\n');

      expect(joined).toContain('**7**');
      expect(joined).toContain('**Full Observation**');
    });

    it('should include detail field when provided', () => {
      const obs = createTestObservation();
      const config = createTestConfig();

      const result = renderAgentFullObservation(obs, '10:00 AM', 'The detailed narrative here', config);
      const joined = result.join('\n');

      expect(joined).toContain('The detailed narrative here');
    });

    it('should not include detail field when null', () => {
      const obs = createTestObservation();
      const config = createTestConfig();

      const result = renderAgentFullObservation(obs, '10:00 AM', null, config);

      // Should not have an extra content block
      expect(result.length).toBeLessThan(5);
    });

    it('should include token info when enabled', () => {
      const obs = createTestObservation({ discovery_tokens: 250 });
      const config = createTestConfig({ showReadTokens: true, showWorkTokens: true });

      const result = renderAgentFullObservation(obs, '10:00 AM', null, config);
      const joined = result.join('\n');

      // Compact format: "~{readTokens}t" and "W {discoveryTokens}"
      expect(joined).toContain('~');
      expect(joined).toContain('t');
      expect(joined).toContain('W 250');
    });
  });

  describe('renderAgentSummaryItem', () => {
    it('should include session ID with S prefix', () => {
      const summary = { id: 5, request: 'Implement feature' };

      const result = renderAgentSummaryItem(summary, '2025-01-01 10:00');
      const joined = result.join('\n');

      expect(joined).toContain('S5');
    });

    it('should include request text', () => {
      const summary = { id: 1, request: 'Build authentication' };

      const result = renderAgentSummaryItem(summary, '10:00');
      const joined = result.join('\n');

      expect(joined).toContain('Build authentication');
    });

    it('should use "Session started" when request is null', () => {
      const summary = { id: 1, request: null };

      const result = renderAgentSummaryItem(summary, '10:00');
      const joined = result.join('\n');

      expect(joined).toContain('Session started');
    });
  });

  describe('renderAgentSummaryField', () => {
    it('should render label and value in bold', () => {
      const result = renderAgentSummaryField('Learned', 'How to test');

      expect(result).toHaveLength(2);
      expect(result[0]).toBe('**Learned**: How to test');
      expect(result[1]).toBe('');
    });

    it('should return empty array when value is null', () => {
      const result = renderAgentSummaryField('Learned', null);

      expect(result).toHaveLength(0);
    });

    it('should return empty array when value is empty string', () => {
      const result = renderAgentSummaryField('Learned', '');

      // Empty string is falsy, so should return empty array
      expect(result).toHaveLength(0);
    });
  });

  describe('renderAgentPreviouslySection', () => {
    it('should render section when assistantMessage exists', () => {
      const priorMessages: PriorMessages = {
        userMessage: '',
        assistantMessage: 'I completed the task successfully.',
      };

      const result = renderAgentPreviouslySection(priorMessages);
      const joined = result.join('\n');

      expect(joined).toContain('**Previously**');
      expect(joined).toContain('A: I completed the task successfully.');
    });

    it('should return empty when assistantMessage is empty', () => {
      const priorMessages: PriorMessages = {
        userMessage: '',
        assistantMessage: '',
      };

      const result = renderAgentPreviouslySection(priorMessages);

      expect(result).toHaveLength(0);
    });

    it('should include separator', () => {
      const priorMessages: PriorMessages = {
        userMessage: '',
        assistantMessage: 'Some message',
      };

      const result = renderAgentPreviouslySection(priorMessages);
      const joined = result.join('\n');

      expect(joined).toContain('---');
    });
  });

  describe('renderAgentFooter', () => {
    it('should include work token amount in k', () => {
      const result = renderAgentFooter(10000, 500);
      const joined = result.join('\n');

      expect(joined).toContain('10k');
    });

    it('should mention mem-search skill', () => {
      const result = renderAgentFooter(5000, 100);
      const joined = result.join('\n');

      expect(joined).toContain('mem-search skill');
    });

    it('should round work tokens to nearest thousand', () => {
      const result = renderAgentFooter(15500, 100);
      const joined = result.join('\n');

      // 15500 / 1000 = 15.5 -> rounds to 16
      expect(joined).toContain('16k');
    });
  });

  describe('renderAgentEmptyState', () => {
    it('should return helpful message with project name', () => {
      const result = renderAgentEmptyState('my-project');

      expect(result).toContain('# [my-project] recent context,');
      expect(result).toContain('No previous sessions found.');
    });

    it('should be valid markdown', () => {
      const result = renderAgentEmptyState('test');

      // Should start with h1
      expect(result.startsWith('#')).toBe(true);
    });

    it('should handle empty project name', () => {
      const result = renderAgentEmptyState('');

      expect(result).toContain('# [] recent context,');
    });
  });
});
