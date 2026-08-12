
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ingestObservation, setIngestContext } from '../../../src/services/worker/http/shared.js';

// The Bash-pattern skip is a pure early return in ingestObservation, before any
// database access, so a stub context is enough. CLAUDE_MEM_SKIP_BASH_PATTERNS is
// applied through the env override in SettingsDefaultsManager.loadFromFile.
describe('ingestObservation — CLAUDE_MEM_SKIP_BASH_PATTERNS', () => {
  let prevPattern: string | undefined;

  beforeEach(() => {
    prevPattern = process.env.CLAUDE_MEM_SKIP_BASH_PATTERNS;
    setIngestContext({
      sessionManager: {} as any,
      dbManager: {} as any,
      eventBroadcaster: {} as any,
    });
  });

  afterEach(() => {
    if (prevPattern === undefined) delete process.env.CLAUDE_MEM_SKIP_BASH_PATTERNS;
    else process.env.CLAUDE_MEM_SKIP_BASH_PATTERNS = prevPattern;
  });

  const bash = (command: string) =>
    ingestObservation({
      contentSessionId: 'test-session',
      toolName: 'Bash',
      toolInput: { command },
      toolResponse: {},
    });

  it('skips a Bash command that matches the pattern', async () => {
    process.env.CLAUDE_MEM_SKIP_BASH_PATTERNS = '^(ls|cat|pwd)\\b';
    const result = await bash('ls -la');
    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'bash_pattern_excluded' });
  });

  // A command that is not skipped falls through to the database path, which the
  // stub context has no store for. The reject proves the Bash branch let it pass.
  it('does not skip a Bash command that fails to match', async () => {
    process.env.CLAUDE_MEM_SKIP_BASH_PATTERNS = '^(ls|cat|pwd)\\b';
    await expect(bash('git commit -m "fix"')).rejects.toThrow();
  });

  it('ignores an invalid regex instead of dropping the observation', async () => {
    process.env.CLAUDE_MEM_SKIP_BASH_PATTERNS = '(unbalanced';
    await expect(bash('ls -la')).rejects.toThrow();
  });
});
