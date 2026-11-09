import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshot in afterAll so the partial ModeManager stub (no
// class prototype, no loadMode) does not leak into later test files (bun's
// mock.module is process-global; mock.restore() does NOT undo it). A leaked
// stub breaks tests/server/server-boot.test.ts, server-runtime-smoke and the
// tests/sdk parser suites whenever the readdir-dependent file order runs them
// after this file.
import * as realModeManagerModule from '../../../src/services/domain/ModeManager.js';

const realModeManagerSnapshot = { ...realModeManagerModule };

afterAll(() => {
  mock.module('../../../src/services/domain/ModeManager.js', () => realModeManagerSnapshot);
});

mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'Code Development',
        prompts: {},
        observation_types: [
          { id: 'decision', emoji: 'D' },
          { id: 'bugfix', emoji: 'B' },
          { id: 'discovery', emoji: 'I' },
        ],
        observation_concepts: [],
      }),
      getActiveModeId: () => 'code',
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
  renderAgentDayHeader,
  renderAgentTableRow,
  renderAgentFullObservation,
  renderAgentSummaryItem,
  renderAgentSummaryField,
  renderAgentPreviouslySection,
  renderAgentEmptyState,
} from '../../../src/services/context/formatters/AgentFormatter.js';

import type { Observation, TokenEconomics, ContextConfig, PriorMessages } from '../../../src/services/context/types.js';
import { formatContextReferenceId } from '../../../src/services/context/formatters/id-display.js';

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
    mainAgentOnly: true,
    ...overrides,
  };
}

describe('AgentFormatter', () => {
  describe('renderAgentDayHeader', () => {
    it('should render day as h3 heading', () => {
      const result = renderAgentDayHeader('2025-01-01');

      expect(result).toHaveLength(1);
      expect(result[0]).toBe('### 2025-01-01');
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

      expect(result.length).toBeLessThan(5);
    });

    it('should include token info when enabled', () => {
      const obs = createTestObservation({ discovery_tokens: 250 });
      const config = createTestConfig({ showReadTokens: true, showWorkTokens: true });

      const result = renderAgentFullObservation(obs, '10:00 AM', null, config);
      const joined = result.join('\n');

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

    it('should abbreviate a server summary UUID when fetch-by-id is unsupported', () => {
      const summary = { id: '3c4b2513-5048-45fa-95e0-e3222ae99671', request: 'Ship it' };

      expect(renderAgentSummaryItem(summary, '10:00', { fetchByIdSupported: false })[0])
        .toBe('S3c4b2513 Ship it (10:00)');
      expect(renderAgentSummaryItem(summary, '10:00')[0])
        .toBe('S3c4b2513-5048-45fa-95e0-e3222ae99671 Ship it (10:00)');
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

      expect(result).toHaveLength(0);
    });
  });

  describe('renderAgentPreviouslySection', () => {
    it('should render section when assistantMessage exists', () => {
      const priorMessages: PriorMessages = {
        assistantMessage: 'I completed the task successfully.',
      };

      const result = renderAgentPreviouslySection(priorMessages);
      const joined = result.join('\n');

      expect(joined).toContain('**Previously**');
      expect(joined).toContain('A: I completed the task successfully.');
    });

    it('should return empty when assistantMessage is empty', () => {
      const priorMessages: PriorMessages = {
        assistantMessage: '',
      };

      const result = renderAgentPreviouslySection(priorMessages);

      expect(result).toHaveLength(0);
    });

    it('opens with its heading, since it sits above the timeline rather than after it', () => {
      const priorMessages: PriorMessages = {
        assistantMessage: 'Some message',
      };

      const result = renderAgentPreviouslySection(priorMessages);

      expect(result[0]).toBe('**Previously**');
      expect(result).not.toContain('---');
    });
  });

  describe('renderAgentEmptyState', () => {
    it('puts lead sections under the header and keeps the empty timeline last', () => {
      const result = renderAgentEmptyState(['HEADER', ''], ['WARNING', '', 'OPEN WORK']);

      expect(result).toBe('HEADER\n\nWARNING\n\nOPEN WORK\n\nNo previous sessions found.');
    });
  });
});

describe('formatContextReferenceId', () => {
  const UUID = '3c4b2513-5048-45fa-95e0-e3222ae99671';

  it('abbreviates UUID ids to their 8-char prefix when fetch-by-id is unsupported', () => {
    expect(formatContextReferenceId(UUID, { fetchByIdSupported: false })).toBe('3c4b2513');
  });

  it('keeps the full UUID when fetch-by-id is supported', () => {
    expect(formatContextReferenceId(UUID, { fetchByIdSupported: true })).toBe(UUID);
  });

  it('defaults to the full id when fetchByIdSupported is omitted (backward compatible)', () => {
    expect(formatContextReferenceId(UUID, {})).toBe(UUID);
  });

  it('leaves non-UUID (numeric) ids unchanged even when fetch-by-id is unsupported', () => {
    expect(formatContextReferenceId(42, { fetchByIdSupported: false })).toBe('42');
  });
});
