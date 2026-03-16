import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock the ModeManager before imports
mock.module('../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getTypeIcon: (type: string) => {
        const icons: Record<string, string> = {
          decision: 'D',
          bugfix: 'B',
          feature: 'F',
          discovery: 'I',
        };
        return icons[type] || '?';
      },
      getWorkEmoji: () => 'W',
    }),
  },
}));

import { ResultFormatter } from '../src/services/worker/search/ResultFormatter.js';
import type { ObservationSearchResult } from '../src/services/worker/search/types.js';

function makeObservation(overrides: Partial<ObservationSearchResult> = {}): ObservationSearchResult {
  return {
    id: 42,
    memory_session_id: 'session-abc',
    project: 'test-project',
    text: 'Test text',
    type: 'discovery',
    title: 'Found a Bug Pattern',
    subtitle: 'Subtitle here',
    facts: '["fact1"]',
    narrative: 'Some narrative',
    concepts: '["concept1"]',
    files_read: '["src/a.ts"]',
    files_modified: '["src/b.ts"]',
    prompt_number: 1,
    discovery_tokens: 100,
    created_at: '2026-03-15T12:00:00.000Z',
    created_at_epoch: 1773840000000,
    ...overrides,
  };
}

describe('MCP Output Metadata - Branch Fields', () => {
  let formatter: ResultFormatter;

  beforeEach(() => {
    formatter = new ResultFormatter();
  });

  describe('ObservationSearchResult type includes branch/commit_sha', () => {
    it('should allow branch and commit_sha fields on ObservationSearchResult', () => {
      const obs = makeObservation({
        branch: 'feature/auth-flow',
        commit_sha: 'abc123def456',
      });

      // TypeScript compilation proves the fields exist on the type
      expect(obs.branch).toBe('feature/auth-flow');
      expect(obs.commit_sha).toBe('abc123def456');
    });

    it('should allow null branch and commit_sha (pre-migration observations)', () => {
      const obs = makeObservation({
        branch: null,
        commit_sha: null,
      });

      expect(obs.branch).toBeNull();
      expect(obs.commit_sha).toBeNull();
    });

    it('should allow undefined branch and commit_sha (backward compat)', () => {
      const obs = makeObservation();
      // No branch/commit_sha set in overrides

      expect(obs.branch).toBeUndefined();
      expect(obs.commit_sha).toBeUndefined();
    });
  });

  describe('ResultFormatter.formatObservationSearchRow() branch display', () => {
    it('should include branch in title when branch is present', () => {
      const obs = makeObservation({ branch: 'feature/auth' });
      const result = formatter.formatObservationSearchRow(obs, '');

      expect(result.row).toContain('Found a Bug Pattern [feature/auth]');
    });

    it('should display title unchanged when branch is null', () => {
      const obs = makeObservation({ branch: null });
      const result = formatter.formatObservationSearchRow(obs, '');

      expect(result.row).toContain('Found a Bug Pattern');
      expect(result.row).not.toContain('[');
    });

    it('should display title unchanged when branch is undefined', () => {
      const obs = makeObservation();
      const result = formatter.formatObservationSearchRow(obs, '');

      expect(result.row).toContain('Found a Bug Pattern');
      expect(result.row).not.toContain('[');
    });

    it('should truncate long branch names to 20 chars with ellipsis', () => {
      const longBranch = 'feature/very-long-branch-name-that-exceeds-twenty-chars';
      const obs = makeObservation({ branch: longBranch });
      const result = formatter.formatObservationSearchRow(obs, '');

      // Should be truncated: 17 chars + '...' = 20 chars
      expect(result.row).toContain('[feature/very-long...');
      expect(result.row).not.toContain(longBranch);
    });

    it('should not truncate branch names at exactly 20 chars', () => {
      const exactBranch = '12345678901234567890'; // exactly 20 chars
      const obs = makeObservation({ branch: exactBranch });
      const result = formatter.formatObservationSearchRow(obs, '');

      expect(result.row).toContain(`[${exactBranch}]`);
      expect(result.row).not.toContain('...');
    });

    it('should not truncate branch names under 20 chars', () => {
      const shortBranch = 'main';
      const obs = makeObservation({ branch: shortBranch });
      const result = formatter.formatObservationSearchRow(obs, '');

      expect(result.row).toContain('[main]');
    });
  });

  describe('ResultFormatter.truncateBranch()', () => {
    it('should return short names unchanged', () => {
      expect(formatter.truncateBranch('main')).toBe('main');
    });

    it('should return exactly 20-char names unchanged', () => {
      const name = '12345678901234567890';
      expect(formatter.truncateBranch(name)).toBe(name);
    });

    it('should truncate 21+ char names to 17 chars + ellipsis', () => {
      const name = '123456789012345678901'; // 21 chars
      expect(formatter.truncateBranch(name)).toBe('12345678901234567...');
      expect(formatter.truncateBranch(name).length).toBe(20);
    });
  });
});
