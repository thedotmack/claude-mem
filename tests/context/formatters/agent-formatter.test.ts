import { describe, it, expect, mock, afterAll } from 'bun:test';

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
  renderAgentHeader,
  renderAgentLegend,
  renderAgentContextEconomics,
  renderAgentDayHeader,
  renderAgentTableRow,
  renderAgentFullObservation,
  renderAgentSummaryItem,
  renderAgentSummaryField,
  renderAgentPreviouslySection,
  renderAgentEmptyState,
} from '../../../src/services/context/formatters/AgentFormatter.js';

import type { Observation, TokenEconomics, ContextConfig } from '../../../src/services/context/types.js';
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
  describe('renderAgentHeader', () => {
    it('renders the current date and time by default', () => {
      const result = renderAgentHeader('my-project');
      expect(result[0]).toMatch(/^# \[my-project\] recent context, \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}[ap]m [A-Z]{3,4}$/);
      expect(result.slice(1)).toEqual(['Mode: Code Development (code)', '']);
    });

    it.each(['my-project', 'project-with-special_chars.v2', ''])('renders project %j', (project) => {
      expect(renderAgentHeader(project, 'NOW')).toEqual([
        `# [${project}] recent context, NOW`, 'Mode: Code Development (code)', '',
      ]);
    });
  });

  describe('renderAgentLegend', () => {
    it.each([undefined, true, false])('renders the fetch hint for %j', (fetchByIdSupported) => {
      expect(renderAgentLegend(fetchByIdSupported)).toEqual([
        'Legend: 🎯session Ddecision Bbugfix Idiscovery',
        'Format: ID TIME TYPE TITLE',
        fetchByIdSupported === false
          ? 'Fetch details: observation_search by title (short refs are display-only)'
          : 'Fetch details: get_observations([IDs]) | Search: mem-search skill',
        '',
      ]);
    });
  });

  describe('renderAgentContextEconomics', () => {
    it.each([
      [{ totalObservations: 25 }, {}, '25 obs (500t read) | 5,000t work | 4,500t saved | 90% savings'],
      [{ totalReadTokens: 1500 }, {}, '10 obs (1,500t read) | 5,000t work | 4,500t saved | 90% savings'],
      [{ totalDiscoveryTokens: 10000 }, {}, '10 obs (500t read) | 10,000t work | 4,500t saved | 90% savings'],
      [{ savings: 4500, savingsPercent: 90, totalDiscoveryTokens: 5000 }, { showSavingsAmount: true, showSavingsPercent: false }, '10 obs (500t read) | 5,000t work | 4,500t saved'],
      [{ savingsPercent: 85, totalDiscoveryTokens: 1000 }, { showSavingsAmount: false, showSavingsPercent: true }, '10 obs (500t read) | 1,000t work | 85% savings'],
      [{ savings: 4500, savingsPercent: 90, totalDiscoveryTokens: 5000 }, { showSavingsAmount: true, showSavingsPercent: true }, '10 obs (500t read) | 5,000t work | 4,500t saved | 90% savings'],
      [{ totalDiscoveryTokens: 0, savings: 0, savingsPercent: 0 }, { showSavingsAmount: true, showSavingsPercent: true }, '10 obs (500t read) | 0t work'],
    ] as [Partial<TokenEconomics>, Partial<ContextConfig>, string][])('renders economics %j with %j', (economics, config, expected) => {
      expect(renderAgentContextEconomics(createTestEconomics(economics), createTestConfig(config)))
        .toEqual([`Stats: ${expected}`, '']);
    });
  });

  it('renders the day as a heading', () => {
    expect(renderAgentDayHeader('2025-01-01')).toEqual(['### 2025-01-01']);
  });

  describe('renderAgentTableRow', () => {
    it.each([
      [{ id: 42 }, '10:30 AM', '42 10:30a I Test Observation'],
      [{}, '2:30 PM', '1 2:30p I Test Observation'],
      [{ title: 'Important Discovery' }, '10:00 AM', '1 10:00a I Important Discovery'],
      [{ title: null }, '10:00 AM', '1 10:00a I Untitled'],
      [{ id: 5 }, '10:00 AM', '5 10:00a I Test Observation'],
      [{}, '', '1 " I Test Observation'],
    ] as [Partial<Observation>, string, string][])('renders %j at %s', (observation, time, expected) => {
      expect(renderAgentTableRow(createTestObservation(observation), time, createTestConfig())).toBe(expected);
    });
  });

  describe('renderAgentFullObservation', () => {
    it.each([
      [{ id: 7, title: 'Full Observation' }, 'Detail content', {}, ['**7** 10:00a I **Full Observation**', 'Detail content', '~12t W 100', '']],
      [{}, 'The detailed narrative here', {}, ['**1** 10:00a I **Test Observation**', 'The detailed narrative here', '~12t W 100', '']],
      [{}, null, {}, ['**1** 10:00a I **Test Observation**', '~12t W 100', '']],
      [{ discovery_tokens: 250 }, null, { showReadTokens: true, showWorkTokens: true }, ['**1** 10:00a I **Test Observation**', '~12t W 250', '']],
    ] as [Partial<Observation>, string | null, Partial<ContextConfig>, string[]][])('renders %j with detail %j', (observation, detail, config, expected) => {
      expect(renderAgentFullObservation(createTestObservation(observation), '10:00 AM', detail, createTestConfig(config)))
        .toEqual(expected);
    });
  });

  describe('renderAgentSummaryItem', () => {
    it.each([
      [{ id: 5, request: 'Implement feature' }, '2025-01-01 10:00', 'S5 Implement feature (2025-01-01 10:00)'],
      [{ id: 1, request: 'Build authentication' }, '10:00', 'S1 Build authentication (10:00)'],
      [{ id: 1, request: null }, '10:00', 'S1 Session started (10:00)'],
    ])('renders %j at %s', (summary, time, expected) => {
      expect(renderAgentSummaryItem(summary, time)).toEqual([expected]);
    });

    it('abbreviates a server summary UUID when fetch-by-id is unsupported', () => {
      const summary = { id: '3c4b2513-5048-45fa-95e0-e3222ae99671', request: 'Ship it' };
      expect(renderAgentSummaryItem(summary, '10:00', { fetchByIdSupported: false }))
        .toEqual(['S3c4b2513 Ship it (10:00)']);
      expect(renderAgentSummaryItem(summary, '10:00'))
        .toEqual(['S3c4b2513-5048-45fa-95e0-e3222ae99671 Ship it (10:00)']);
    });
  });

  describe('renderAgentSummaryField', () => {
    it.each([
      ['How to test', ['**Learned**: How to test', '']],
      [null, []],
      ['', []],
    ] as [string | null, string[]][])('renders field %j', (value, expected) => {
      expect(renderAgentSummaryField('Learned', value)).toEqual(expected);
    });
  });

  describe('renderAgentPreviouslySection', () => {
    it.each([
      ['I completed the task successfully.', ['**Previously**', '', 'A: I completed the task successfully.', '']],
      ['', []],
      ['Some message', ['**Previously**', '', 'A: Some message', '']],
    ] as [string, string[]][])('renders prior reply %j', (assistantMessage, expected) => {
      expect(renderAgentPreviouslySection({ assistantMessage })).toEqual(expected);
    });
  });

  describe('renderAgentEmptyState', () => {
    it.each(['my-project', 'test', ''])('renders an empty timeline for %j', (project) => {
      expect(renderAgentEmptyState(project, 'NOW'))
        .toBe(`# [${project}] recent context, NOW\nMode: Code Development (code)\n\nNo previous sessions found.`);
    });

    it('puts lead sections under the header and keeps the empty timeline last', () => {
      expect(renderAgentEmptyState('my-project', 'NOW', ['WARNING', '', 'OPEN WORK']))
        .toBe('# [my-project] recent context, NOW\nMode: Code Development (code)\n\nWARNING\n\nOPEN WORK\n\nNo previous sessions found.');
    });
  });
});

describe('formatContextReferenceId', () => {
  const UUID = '3c4b2513-5048-45fa-95e0-e3222ae99671';

  it.each([
    [UUID, { fetchByIdSupported: false }, '3c4b2513'],
    [UUID, { fetchByIdSupported: true }, UUID],
    [UUID, {}, UUID],
    [42, { fetchByIdSupported: false }, '42'],
  ])('formats %j with %j', (id, config, expected) => {
    expect(formatContextReferenceId(id, config)).toBe(expected);
  });
});
