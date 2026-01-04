import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock the ModeManager before imports
mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [
          { id: 'decision', icon: 'D' },
          { id: 'bugfix', icon: 'B' },
          { id: 'feature', icon: 'F' },
          { id: 'refactor', icon: 'R' },
          { id: 'discovery', icon: 'I' },
          { id: 'change', icon: 'C' }
        ],
        observation_concepts: [],
      }),
      getObservationTypes: () => [
        { id: 'decision', icon: 'D' },
        { id: 'bugfix', icon: 'B' },
        { id: 'feature', icon: 'F' },
        { id: 'refactor', icon: 'R' },
        { id: 'discovery', icon: 'I' },
        { id: 'change', icon: 'C' }
      ],
      getTypeIcon: (type: string) => {
        const icons: Record<string, string> = {
          decision: 'D',
          bugfix: 'B',
          feature: 'F',
          refactor: 'R',
          discovery: 'I',
          change: 'C'
        };
        return icons[type] || '?';
      },
      getWorkEmoji: () => 'W',
    }),
  },
}));

import { ResultFormatter } from '../../../src/services/worker/search/ResultFormatter.js';
import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult, SearchResults } from '../../../src/services/worker/search/types.js';

// Mock data
const mockObservation: ObservationSearchResult = {
  id: 1,
  memory_session_id: 'session-123',
  project: 'test-project',
  text: 'Test observation text',
  type: 'decision',
  title: 'Test Decision Title',
  subtitle: 'A descriptive subtitle',
  facts: '["fact1", "fact2"]',
  narrative: 'This is the narrative description',
  concepts: '["concept1", "concept2"]',
  files_read: '["src/file1.ts"]',
  files_modified: '["src/file2.ts"]',
  prompt_number: 1,
  discovery_tokens: 100,
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: 1735732800000
};

const mockSession: SessionSummarySearchResult = {
  id: 1,
  memory_session_id: 'session-123',
  project: 'test-project',
  request: 'Implement feature X',
  investigated: 'Looked at code structure',
  learned: 'Learned about the architecture',
  completed: 'Added new feature',
  next_steps: 'Write tests',
  files_read: '["src/index.ts"]',
  files_edited: '["src/feature.ts"]',
  notes: 'Additional notes',
  prompt_number: 1,
  discovery_tokens: 500,
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: 1735732800000
};

const mockPrompt: UserPromptSearchResult = {
  id: 1,
  content_session_id: 'content-123',
  prompt_number: 1,
  prompt_text: 'Can you help me implement feature X?',
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: 1735732800000
};

describe('ResultFormatter', () => {
  let formatter: ResultFormatter;

  beforeEach(() => {
    formatter = new ResultFormatter();
  });

  describe('formatSearchResults', () => {
    it('should format observations as markdown', () => {
      const results: SearchResults = {
        observations: [mockObservation],
        sessions: [],
        prompts: []
      };

      const formatted = formatter.formatSearchResults(results, 'test query');

      expect(formatted).toContain('test query');
      expect(formatted).toContain('1 result');
      expect(formatted).toContain('1 obs');
      expect(formatted).toContain('#1'); // ID
      expect(formatted).toContain('Test Decision Title');
    });

    it('should format sessions as markdown', () => {
      const results: SearchResults = {
        observations: [],
        sessions: [mockSession],
        prompts: []
      };

      const formatted = formatter.formatSearchResults(results, 'session query');

      expect(formatted).toContain('1 session');
      expect(formatted).toContain('#S1'); // Session ID format
      expect(formatted).toContain('Implement feature X');
    });

    it('should format prompts as markdown', () => {
      const results: SearchResults = {
        observations: [],
        sessions: [],
        prompts: [mockPrompt]
      };

      const formatted = formatter.formatSearchResults(results, 'prompt query');

      expect(formatted).toContain('1 prompt');
      expect(formatted).toContain('#P1'); // Prompt ID format
      expect(formatted).toContain('Can you help me implement');
    });

    it('should handle empty results', () => {
      const results: SearchResults = {
        observations: [],
        sessions: [],
        prompts: []
      };

      const formatted = formatter.formatSearchResults(results, 'no matches');

      expect(formatted).toContain('No results found');
      expect(formatted).toContain('no matches');
    });

    it('should show combined count for multiple types', () => {
      const results: SearchResults = {
        observations: [mockObservation],
        sessions: [mockSession],
        prompts: [mockPrompt]
      };

      const formatted = formatter.formatSearchResults(results, 'mixed query');

      expect(formatted).toContain('3 result(s)');
      expect(formatted).toContain('1 obs');
      expect(formatted).toContain('1 sessions');
      expect(formatted).toContain('1 prompts');
    });

    it('should escape special characters in query', () => {
      const results: SearchResults = {
        observations: [mockObservation],
        sessions: [],
        prompts: []
      };

      const formatted = formatter.formatSearchResults(results, 'query with "quotes"');

      expect(formatted).toContain('query with "quotes"');
    });

    it('should include table headers', () => {
      const results: SearchResults = {
        observations: [mockObservation],
        sessions: [],
        prompts: []
      };

      const formatted = formatter.formatSearchResults(results, 'test');

      expect(formatted).toContain('| ID |');
      expect(formatted).toContain('| Time |');
      expect(formatted).toContain('| T |');
      expect(formatted).toContain('| Title |');
    });

    it('should indicate Chroma failure when chromaFailed is true', () => {
      const results: SearchResults = {
        observations: [],
        sessions: [],
        prompts: []
      };

      const formatted = formatter.formatSearchResults(results, 'test', true);

      expect(formatted).toContain('Vector search failed');
      expect(formatted).toContain('semantic search unavailable');
    });
  });

  describe('combineResults', () => {
    it('should combine all result types into unified format', () => {
      const results: SearchResults = {
        observations: [mockObservation],
        sessions: [mockSession],
        prompts: [mockPrompt]
      };

      const combined = formatter.combineResults(results);

      expect(combined).toHaveLength(3);
      expect(combined.some(r => r.type === 'observation')).toBe(true);
      expect(combined.some(r => r.type === 'session')).toBe(true);
      expect(combined.some(r => r.type === 'prompt')).toBe(true);
    });

    it('should include epoch for sorting', () => {
      const results: SearchResults = {
        observations: [mockObservation],
        sessions: [],
        prompts: []
      };

      const combined = formatter.combineResults(results);

      expect(combined[0].epoch).toBe(mockObservation.created_at_epoch);
    });

    it('should include created_at for display', () => {
      const results: SearchResults = {
        observations: [mockObservation],
        sessions: [],
        prompts: []
      };

      const combined = formatter.combineResults(results);

      expect(combined[0].created_at).toBe(mockObservation.created_at);
    });
  });

  describe('formatTableHeader', () => {
    it('should include Work column', () => {
      const header = formatter.formatTableHeader();

      expect(header).toContain('| Work |');
      expect(header).toContain('| ID |');
      expect(header).toContain('| Time |');
    });
  });

  describe('formatSearchTableHeader', () => {
    it('should not include Work column', () => {
      const header = formatter.formatSearchTableHeader();

      expect(header).not.toContain('| Work |');
      expect(header).toContain('| Read |');
    });
  });

  describe('formatObservationSearchRow', () => {
    it('should format observation as table row', () => {
      const result = formatter.formatObservationSearchRow(mockObservation, '');

      expect(result.row).toContain('#1');
      expect(result.row).toContain('Test Decision Title');
      expect(result.row).toContain('~'); // Token estimate
    });

    it('should use quote mark for repeated time', () => {
      // First get the actual time format for this observation
      const firstResult = formatter.formatObservationSearchRow(mockObservation, '');
      // Now pass that same time as lastTime
      const result = formatter.formatObservationSearchRow(mockObservation, firstResult.time);

      // When time matches lastTime, the row should show quote mark
      expect(result.row).toContain('"');
      expect(result.time).toBe(firstResult.time);
    });

    it('should return the time for tracking', () => {
      const result = formatter.formatObservationSearchRow(mockObservation, '');

      expect(typeof result.time).toBe('string');
    });
  });

  describe('formatSessionSearchRow', () => {
    it('should format session as table row', () => {
      const result = formatter.formatSessionSearchRow(mockSession, '');

      expect(result.row).toContain('#S1');
      expect(result.row).toContain('Implement feature X');
    });

    it('should fallback to session ID prefix when no request', () => {
      const sessionNoRequest = { ...mockSession, request: null };
      const result = formatter.formatSessionSearchRow(sessionNoRequest, '');

      expect(result.row).toContain('Session session-');
    });
  });

  describe('formatPromptSearchRow', () => {
    it('should format prompt as table row', () => {
      const result = formatter.formatPromptSearchRow(mockPrompt, '');

      expect(result.row).toContain('#P1');
      expect(result.row).toContain('Can you help me implement');
    });

    it('should truncate long prompts', () => {
      const longPrompt = {
        ...mockPrompt,
        prompt_text: 'A'.repeat(100)
      };

      const result = formatter.formatPromptSearchRow(longPrompt, '');

      expect(result.row).toContain('...');
      expect(result.row.length).toBeLessThan(longPrompt.prompt_text.length + 50);
    });
  });

  describe('formatObservationIndex', () => {
    it('should include Work column in index format', () => {
      const row = formatter.formatObservationIndex(mockObservation, 0);

      expect(row).toContain('#1');
      // Should have more columns than search row
      expect(row.split('|').length).toBeGreaterThan(5);
    });

    it('should show discovery tokens as work', () => {
      const obsWithTokens = { ...mockObservation, discovery_tokens: 250 };
      const row = formatter.formatObservationIndex(obsWithTokens, 0);

      expect(row).toContain('250');
    });

    it('should show dash when no discovery tokens', () => {
      const obsNoTokens = { ...mockObservation, discovery_tokens: 0 };
      const row = formatter.formatObservationIndex(obsNoTokens, 0);

      expect(row).toContain('-');
    });
  });

  describe('formatSessionIndex', () => {
    it('should include session ID prefix', () => {
      const row = formatter.formatSessionIndex(mockSession, 0);

      expect(row).toContain('#S1');
    });
  });

  describe('formatPromptIndex', () => {
    it('should include prompt ID prefix', () => {
      const row = formatter.formatPromptIndex(mockPrompt, 0);

      expect(row).toContain('#P1');
    });
  });

  describe('formatSearchTips', () => {
    it('should include search strategy tips', () => {
      const tips = formatter.formatSearchTips();

      expect(tips).toContain('Search Strategy');
      expect(tips).toContain('timeline');
      expect(tips).toContain('get_observations');
    });

    it('should include filter examples', () => {
      const tips = formatter.formatSearchTips();

      expect(tips).toContain('obs_type');
      expect(tips).toContain('dateStart');
      expect(tips).toContain('orderBy');
    });
  });
});
