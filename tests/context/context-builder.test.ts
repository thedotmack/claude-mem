import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

// Create mock functions that can be accessed
const mockPrepare = mock(() => ({
  all: mock(() => []),
  run: mock(() => {}),
}));

const mockClose = mock(() => {});

// Mock SessionStore before importing ContextBuilder
mock.module('../../src/services/sqlite/SessionStore.js', () => ({
  SessionStore: class MockSessionStore {
    db = {
      prepare: mockPrepare,
    };
    close = mockClose;
  },
}));

// Mock the logger
mock.module('../../src/utils/logger.js', () => ({
  logger: {
    debug: mock(() => {}),
    failure: mock(() => {}),
    error: mock(() => {}),
    info: mock(() => {}),
  },
}));

// Mock project-name utility
mock.module('../../src/utils/project-name.js', () => ({
  getProjectName: mock((cwd: string) => cwd.split('/').pop() || 'unknown'),
}));

// Mock SettingsDefaultsManager
mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    loadFromFile: mock(() => ({
      CLAUDE_MEM_MODE: 'code',
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
      CLAUDE_MEM_CONTEXT_FULL_COUNT: '5',
      CLAUDE_MEM_CONTEXT_SESSION_COUNT: '3',
      CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: 'true',
      CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: 'true',
      CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'true',
      CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',
      CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES: 'discovery,decision,bugfix',
      CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS: 'architecture,testing',
      CLAUDE_MEM_CONTEXT_FULL_FIELD: 'narrative',
      CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
      CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
    })),
  },
}));

// Mock ModeManager
mock.module('../../src/services/domain/ModeManager.js', () => ({
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
        observation_concepts: [
          { id: 'architecture' },
          { id: 'testing' },
        ],
      }),
      getTypeIcon: (type: string) => {
        const icons: Record<string, string> = { decision: 'D', bugfix: 'B', discovery: 'I' };
        return icons[type] || '?';
      },
      getWorkEmoji: () => 'W',
    }),
  },
}));

import { generateContext, loadContextConfig } from '../../src/services/context/index.js';
import type { ContextConfig } from '../../src/services/context/types.js';

describe('ContextBuilder', () => {
  beforeEach(() => {
    mockPrepare.mockClear();
    mockClose.mockClear();
  });

  describe('loadContextConfig', () => {
    it('should return valid ContextConfig object', () => {
      const config = loadContextConfig();

      expect(config).toBeDefined();
      expect(typeof config.totalObservationCount).toBe('number');
      expect(typeof config.fullObservationCount).toBe('number');
      expect(typeof config.sessionCount).toBe('number');
    });

    it('should parse observation count as number', () => {
      const config = loadContextConfig();

      expect(config.totalObservationCount).toBe(50);
    });

    it('should parse full observation count as number', () => {
      const config = loadContextConfig();

      expect(config.fullObservationCount).toBe(5);
    });

    it('should parse session count as number', () => {
      const config = loadContextConfig();

      expect(config.sessionCount).toBe(3);
    });

    it('should parse boolean flags correctly', () => {
      const config = loadContextConfig();

      expect(config.showReadTokens).toBe(true);
      expect(config.showWorkTokens).toBe(true);
      expect(config.showSavingsAmount).toBe(true);
      expect(config.showSavingsPercent).toBe(true);
    });

    it('should parse observation types into Set', () => {
      const config = loadContextConfig();

      expect(config.observationTypes instanceof Set).toBe(true);
      expect(config.observationTypes.has('discovery')).toBe(true);
      expect(config.observationTypes.has('decision')).toBe(true);
      expect(config.observationTypes.has('bugfix')).toBe(true);
    });

    it('should parse observation concepts into Set', () => {
      const config = loadContextConfig();

      expect(config.observationConcepts instanceof Set).toBe(true);
      expect(config.observationConcepts.has('architecture')).toBe(true);
      expect(config.observationConcepts.has('testing')).toBe(true);
    });

    it('should set fullObservationField', () => {
      const config = loadContextConfig();

      expect(config.fullObservationField).toBe('narrative');
    });

    it('should parse showLastSummary and showLastMessage', () => {
      const config = loadContextConfig();

      expect(config.showLastSummary).toBe(true);
      expect(config.showLastMessage).toBe(false);
    });
  });

  describe('generateContext', () => {
    it('should produce non-empty output when data exists', async () => {
      // Setup mock to return some observations
      mockPrepare.mockImplementation((sql: string) => ({
        all: mock((...args: any[]) => {
          if (sql.includes('FROM observations')) {
            return [{
              id: 1,
              memory_session_id: 'session-1',
              type: 'discovery',
              title: 'Test Discovery',
              subtitle: null,
              narrative: 'Found something interesting',
              facts: '["fact1"]',
              concepts: '["architecture"]',
              files_read: null,
              files_modified: null,
              discovery_tokens: 100,
              created_at: '2025-01-01T12:00:00.000Z',
              created_at_epoch: 1735732800000,
            }];
          }
          return [];
        }),
      }));

      const result = await generateContext({ cwd: '/test/project' }, false);

      expect(result.length).toBeGreaterThan(0);
    });

    it('should return empty state message when no data', async () => {
      // Setup mock to return empty arrays
      mockPrepare.mockImplementation(() => ({
        all: mock(() => []),
      }));

      const result = await generateContext({ cwd: '/test/my-project' }, false);

      expect(result).toContain('recent context');
      expect(result).toContain('No previous sessions');
    });

    it('should contain project name in output', async () => {
      mockPrepare.mockImplementation((sql: string) => ({
        all: mock(() => {
          if (sql.includes('FROM observations')) {
            return [{
              id: 1,
              memory_session_id: 'session-1',
              type: 'discovery',
              title: 'Test',
              subtitle: null,
              narrative: 'Narrative',
              facts: '[]',
              concepts: '["architecture"]',
              files_read: null,
              files_modified: null,
              discovery_tokens: 50,
              created_at: '2025-01-01T12:00:00.000Z',
              created_at_epoch: 1735732800000,
            }];
          }
          return [];
        }),
      }));

      const result = await generateContext({ cwd: '/path/to/awesome-project' }, false);

      expect(result).toContain('awesome-project');
    });

    it('should close database after completion', async () => {
      mockPrepare.mockImplementation(() => ({
        all: mock(() => []),
      }));

      await generateContext({ cwd: '/test/project' }, false);

      expect(mockClose).toHaveBeenCalled();
    });

    it('should contain expected markdown sections', async () => {
      mockPrepare.mockImplementation((sql: string) => ({
        all: mock(() => {
          if (sql.includes('FROM observations')) {
            return [{
              id: 1,
              memory_session_id: 'session-1',
              type: 'discovery',
              title: 'Interesting Finding',
              subtitle: null,
              narrative: 'Description here',
              facts: '["fact"]',
              concepts: '["architecture"]',
              files_read: null,
              files_modified: null,
              discovery_tokens: 200,
              created_at: '2025-01-01T10:00:00.000Z',
              created_at_epoch: 1735725600000,
            }];
          }
          if (sql.includes('FROM session_summaries')) {
            return [{
              id: 1,
              memory_session_id: 'session-1',
              request: 'Build feature',
              investigated: 'Code review',
              learned: 'Best practices',
              completed: 'Initial implementation',
              next_steps: 'Add tests',
              created_at: '2025-01-01T11:00:00.000Z',
              created_at_epoch: 1735729200000,
            }];
          }
          return [];
        }),
      }));

      const result = await generateContext({ cwd: '/test/project' }, false);

      // Should contain header
      expect(result).toContain('recent context');
      // Should contain observation data
      expect(result).toContain('Interesting Finding');
    });

    it('should use cwd from input when provided', async () => {
      mockPrepare.mockImplementation(() => ({
        all: mock(() => []),
      }));

      const result = await generateContext({ cwd: '/custom/path/special-project' }, false);

      expect(result).toContain('special-project');
    });

    it('should handle undefined input gracefully', async () => {
      mockPrepare.mockImplementation(() => ({
        all: mock(() => []),
      }));

      // Should not throw
      const result = await generateContext(undefined, false);

      expect(typeof result).toBe('string');
    });

    it('should produce markdown format when useColors is false', async () => {
      mockPrepare.mockImplementation((sql: string) => ({
        all: mock(() => {
          if (sql.includes('FROM observations')) {
            return [{
              id: 1,
              memory_session_id: 'session-1',
              type: 'discovery',
              title: 'Test',
              subtitle: null,
              narrative: 'Text',
              facts: '[]',
              concepts: '["testing"]',
              files_read: null,
              files_modified: null,
              discovery_tokens: 10,
              created_at: '2025-01-01T12:00:00.000Z',
              created_at_epoch: 1735732800000,
            }];
          }
          return [];
        }),
      }));

      const result = await generateContext({ cwd: '/test/project' }, false);

      // Markdown format uses # for headers
      expect(result).toContain('#');
      // Should not contain ANSI escape codes
      expect(result).not.toContain('\x1b[');
    });
  });
});
