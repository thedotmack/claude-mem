// #2401 — "Include last message" silently no-ops when a cwd component contains
// a ".". Claude Code encodes its per-project transcript directory by replacing
// BOTH path separators AND dots with dashes (e.g. /Users/john.doe/proj ->
// -Users-john-doe-proj). cwdToDashed used to replace only "/", leaving a literal
// "." in the directory name, so the transcript file was never found.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

describe('cwdToDashed (#2401)', () => {
  it('replaces both slashes and dots with dashes (matches Claude Code encoding)', async () => {
    const { cwdToDashed } = await import('../../src/services/context/ObservationCompiler.js');
    expect(cwdToDashed('/Users/john.doe/my-project')).toBe('-Users-john-doe-my-project');
  });

  it('still handles paths with no dots', async () => {
    const { cwdToDashed } = await import('../../src/services/context/ObservationCompiler.js');
    expect(cwdToDashed('/Users/jane/app')).toBe('-Users-jane-app');
  });

  it('encodes dotted directory components (e.g. version dirs)', async () => {
    const { cwdToDashed } = await import('../../src/services/context/ObservationCompiler.js');
    expect(cwdToDashed('/srv/app.v2.1/src')).toBe('-srv-app-v2-1-src');
  });
});

describe('getPriorSessionMessages — dot in cwd component (#2401)', () => {
  // Use the config dir the code actually resolves at runtime (paths.ts reads
  // CLAUDE_CONFIG_DIR at module init, so we read the resolved value rather than
  // trying to override the env after the fact). We write the transcript at the
  // exact path getPriorSessionMessages will look up, then clean it up.
  const cwd = '/Users/john.doe/some-project';
  const dashedCwd = '-Users-john-doe-some-project'; // Claude Code: slashes AND dots -> dashes
  const priorSessionId = 'prior-session-2401-abc';
  let projectDir: string;
  let transcriptPath: string;

  beforeAll(async () => {
    const { CLAUDE_CONFIG_DIR } = await import('../../src/shared/paths.js');
    projectDir = join(CLAUDE_CONFIG_DIR, 'projects', dashedCwd);
    transcriptPath = join(projectDir, `${priorSessionId}.jsonl`);
    mkdirSync(projectDir, { recursive: true });

    const transcriptLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'The recovered prior assistant message.' }] },
    });
    writeFileSync(transcriptPath, transcriptLine + '\n');
  });

  afterAll(() => {
    // Only remove the synthetic project dir we created; never the real config dir.
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('finds the transcript for a cwd whose component contains a dot', async () => {
    const { getPriorSessionMessages } = await import('../../src/services/context/ObservationCompiler.js');

    const observations = [
      { memory_session_id: priorSessionId } as any,
    ];
    const config = { showLastMessage: true } as any;

    const result = getPriorSessionMessages(observations, config, 'current-session-id', cwd);
    expect(result.assistantMessage).toBe('The recovered prior assistant message.');
  });
});
