import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `content_session_id` and `memory_session_id` reach the local database from
 * host payloads and synced rows. Either can be used as the last path segment of
 * the prior-session transcript lookup, so a value containing a separator can
 * walk out of the project's transcript directory and read another project's
 * transcript (or any other `.jsonl` file the user can read) into the injected
 * context.
 *
 * The lookup runs in a child process with its own CLAUDE_CONFIG_DIR, so the
 * fixtures and cleanup never touch a real ~/.claude/projects.
 */
const fixture = String.raw`
  import { mkdirSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { getPriorSessionMessages } from './src/services/context/ObservationCompiler.ts';
  const config = process.env.CLAUDE_CONFIG_DIR;
  const projectDir = join(config, 'projects', '-proj');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(config, 'outside'), { recursive: true });
  writeFileSync(join(projectDir, 'valid-session.jsonl'), JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text: 'VALID-REPLY' }] },
  }) + '\n');
  writeFileSync(join(projectDir, 'valid-memory.jsonl'), JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text: 'VALID-MEMORY-REPLY' }] },
  }) + '\n');
  writeFileSync(join(config, 'outside', 'sentinel.jsonl'), JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text: 'LEAKED-SENTINEL' }] },
  }) + '\n');
  // The path an unguarded backslash id resolves to on POSIX: one literal file
  // name inside the project directory. On Windows the same join walks outside,
  // which the sentinel above already covers.
  writeFileSync(join(projectDir, '..\\..\\outside\\sentinel.jsonl'), JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text: 'LEAKED-SENTINEL' }] },
  }) + '\n');
  const configOptions = { showLastMessage: true };
  const valid = getPriorSessionMessages([{ content_session_id: 'valid-session' }], configOptions, 'current', '/proj');
  const validMemory = getPriorSessionMessages([{ content_session_id: null, memory_session_id: 'valid-memory' }], configOptions, 'current', '/proj');
  const slashTraversal = getPriorSessionMessages([{ content_session_id: '../../outside/sentinel' }], configOptions, 'current', '/proj');
  const backslashTraversal = getPriorSessionMessages([{ content_session_id: '..\\..\\outside\\sentinel' }], configOptions, 'current', '/proj');
  const memoryTraversal = getPriorSessionMessages([{ content_session_id: null, memory_session_id: '../../outside/sentinel' }], configOptions, 'current', '/proj');
  console.log(JSON.stringify({ valid, validMemory, slashTraversal, backslashTraversal, memoryTraversal }));
`;

describe('getPriorSessionMessages — session id is a single path segment', () => {
  it('still reads a normal prior transcript but never walks out through either field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-prior-path-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') },
        stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const line = new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!;
      const result = JSON.parse(line);
      expect(result.valid).toEqual({ assistantMessage: 'VALID-REPLY' });
      expect(result.validMemory).toEqual({ assistantMessage: 'VALID-MEMORY-REPLY' });
      expect(result.slashTraversal).toEqual({ assistantMessage: '' });
      expect(result.backslashTraversal).toEqual({ assistantMessage: '' });
      expect(result.memoryTraversal).toEqual({ assistantMessage: '' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
