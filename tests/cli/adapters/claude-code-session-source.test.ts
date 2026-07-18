import { describe, it, expect } from 'bun:test';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';

describe('claudeCodeAdapter.normalizeInput — sessionSource mapping', () => {
  for (const source of ['startup', 'resume', 'clear', 'compact'] as const) {
    it(`maps source '${source}' to sessionSource`, () => {
      const normalized = claudeCodeAdapter.normalizeInput({
        session_id: 's1',
        cwd: '/tmp',
        source,
      });

      expect(normalized.sessionSource).toBe(source);
    });
  }

  it('leaves sessionSource undefined for an unknown source value', () => {
    const normalized = claudeCodeAdapter.normalizeInput({
      session_id: 's1',
      cwd: '/tmp',
      source: 'mystery',
    });

    expect(normalized.sessionSource).toBeUndefined();
  });

  it('leaves sessionSource undefined when source is absent', () => {
    const normalized = claudeCodeAdapter.normalizeInput({
      session_id: 's1',
      cwd: '/tmp',
    });

    expect(normalized.sessionSource).toBeUndefined();
  });

  it('leaves sessionSource undefined for a non-string source', () => {
    const normalized = claudeCodeAdapter.normalizeInput({
      session_id: 's1',
      cwd: '/tmp',
      source: 42,
    });

    expect(normalized.sessionSource).toBeUndefined();
  });

  it('maps sessionId, cwd, and transcriptPath alongside source (SessionStart payload)', () => {
    const normalized = claudeCodeAdapter.normalizeInput({
      session_id: 's1',
      cwd: '/tmp',
      source: 'compact',
      transcript_path: '/tmp/transcript.jsonl',
    });

    expect(normalized.sessionId).toBe('s1');
    expect(normalized.cwd).toBe('/tmp');
    expect(normalized.transcriptPath).toBe('/tmp/transcript.jsonl');
    expect(normalized.sessionSource).toBe('compact');
  });
});
