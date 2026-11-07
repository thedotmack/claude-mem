// Follow-up to #2401: Claude Code encodes its per-project transcript directory
// by replacing EVERY non-alphanumeric character with a dash, not only "/" and
// ".". A real macOS temp cwd is `/var/folders/m8/w_4jf2z.../T/...`, and Claude
// Code stores its transcript under `-var-folders-m8-w-4jf2z...-T-...` (the "_"
// becomes "-"). cwdToDashed replaced only "/" and ".", so it left the "_"
// intact and the transcript directory it built never existed — "Include last
// message" (and memory-dir resolution) silently no-opped for any cwd component
// containing "_", a space, or other punctuation.
//
// Every expected name below is what Claude Code 2.1.289's own encoder returns.

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
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

  it('turns a space and each UTF-16 half of an emoji into its own dash', async () => {
    const { cwdToDashed } = await import('../../src/services/context/ObservationCompiler.js');
    // Space, the emoji's two surrogate halves, then "/": four dashes in a row.
    expect(cwdToDashed('/Users/jane/my repo 🧠/x')).toBe('-Users-jane-my-repo----x');
    // The shape of a Superset worktree checkout: `.../worktrees/claude-mem 🧠/<name>`.
    expect(cwdToDashed('/Users/jane/.superset/worktrees/claude-mem 🧠/pollen-direction')).toBe(
      '-Users-jane--superset-worktrees-claude-mem----pollen-direction',
    );
  });

  it('cuts a name longer than 200 characters to 200 plus a hash of the raw cwd', async () => {
    const { cwdToDashed } = await import('../../src/services/context/ObservationCompiler.js');
    expect(cwdToDashed('/' + 'a'.repeat(199))).toBe('-' + 'a'.repeat(199)); // exactly 200: kept whole
    expect(cwdToDashed('/' + 'a'.repeat(200))).toBe('-' + 'a'.repeat(199) + '-b6ymvl');
    expect(cwdToDashed('/srv/' + 'deep/'.repeat(50) + 'repo')).toBe('-srv-' + 'deep-'.repeat(39) + '-wv1om1');
  });
});

// The lookup runs in a child process with its own CLAUDE_CONFIG_DIR, so the
// transcripts it writes (and the cleanup) never touch a real ~/.claude/projects.
// Each transcript sits under the literal directory name Claude Code writes.
const transcriptLookupFixture = String.raw`
  import { mkdirSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { getPriorSessionMessages } from './src/services/context/ObservationCompiler.ts';
  const onDiskNameByCwd = {
    '/Users/john.doe/some-project': '-Users-john-doe-some-project',
    '/Users/jane/my_project': '-Users-jane-my-project',
    '/Users/jane/.superset/worktrees/claude-mem \u{1F9E0}/pollen-direction': '-Users-jane--superset-worktrees-claude-mem----pollen-direction',
  };
  const assistantMessageByOnDiskName = {};
  for (const [cwd, onDiskName] of Object.entries(onDiskNameByCwd)) {
    const projectDir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', onDiskName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'prior-session.jsonl'), JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'text', text: 'Prior reply stored in ' + onDiskName }] },
    }) + '\n');
    assistantMessageByOnDiskName[onDiskName] = getPriorSessionMessages(
      [{ memory_session_id: 'prior-session' }], { showLastMessage: true }, 'current-session', cwd,
    ).assistantMessage;
  }
  console.log(JSON.stringify(assistantMessageByOnDiskName));
`;

describe('getPriorSessionMessages — cwds Claude Code encodes', () => {
  it('finds the prior transcript for dotted, underscored, and space-and-emoji cwds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-cwd-encoding-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', transcriptLookupFixture], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') },
        stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const found = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      expect(found).toEqual({
        '-Users-john-doe-some-project': 'Prior reply stored in -Users-john-doe-some-project',
        '-Users-jane-my-project': 'Prior reply stored in -Users-jane-my-project',
        '-Users-jane--superset-worktrees-claude-mem----pollen-direction':
          'Prior reply stored in -Users-jane--superset-worktrees-claude-mem----pollen-direction',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
