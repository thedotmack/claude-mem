// Follow-up to #2401: Claude Code encodes its per-project transcript directory
// by replacing EVERY non-alphanumeric character with a dash, not only "/" and
// ".". A real macOS temp cwd is `/var/folders/m8/w_4jf2z.../T/...`, and Claude
// Code stores its transcript under `-var-folders-m8-w-4jf2z...-T-...` (the "_"
// becomes "-"). cwdToDashed replaced only "/" and ".", so it left the "_"
// intact and the transcript directory it built never existed — "Include last
// message" (and memory-dir resolution) silently no-opped for any cwd component
// containing "_", a space, or other punctuation.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

describe('cwdToDashed — non-alphanumeric components', () => {
  it('replaces underscores with dashes (matches Claude Code encoding)', async () => {
    const { cwdToDashed } = await import('../../src/services/context/ObservationCompiler.js');
    expect(cwdToDashed('/Users/jane/my_project')).toBe('-Users-jane-my-project');
  });

  it('encodes a real macOS temp cwd exactly as Claude Code does', async () => {
    const { cwdToDashed } = await import('../../src/services/context/ObservationCompiler.js');
    expect(cwdToDashed('/private/var/folders/m8/w_4jf2z54834ck071hw71p280000gn/T/proj')).toBe(
      '-private-var-folders-m8-w-4jf2z54834ck071hw71p280000gn-T-proj',
    );
  });

  it('still handles the slash/dot cases from #2401', async () => {
    const { cwdToDashed } = await import('../../src/services/context/ObservationCompiler.js');
    expect(cwdToDashed('/Users/john.doe/my-project')).toBe('-Users-john-doe-my-project');
  });
});

describe('getPriorSessionMessages — underscore in cwd component', () => {
  const cwd = '/Users/jane/my_project';
  const dashedCwd = '-Users-jane-my-project'; // Claude Code: "_" -> "-"
  const priorSessionId = 'prior-session-underscore-abc';
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
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('finds the transcript for a cwd whose component contains an underscore', async () => {
    const { getPriorSessionMessages } = await import('../../src/services/context/ObservationCompiler.js');

    const observations = [
      { memory_session_id: priorSessionId } as any,
    ];
    const config = { showLastMessage: true } as any;

    const result = getPriorSessionMessages(observations, config, 'current-session-id', cwd);
    expect(result.assistantMessage).toBe('The recovered prior assistant message.');
  });
});
