import { closeSync, openSync, readSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { OBS_PROMPT_FIELD_MAX_CHARS, OBS_PROMPT_FIELD_TAIL_RATIO } from '../../sdk/prompts.js';
import { retainTextHeadTail } from '../../shared/text-truncation.js';
import { logger } from '../../utils/logger.js';

/**
 * Claude Code cuts a Bash result longer than `bashOutputMaxChars` (30,000 by default), writes the whole output to
 * `<config>/projects/<project>/<session>/tool-results/<id>.txt`, and sends that path as `persistedOutputPath` (#6282).
 * The `stdout` in the hook payload is then only the head of the output, so the last lines, where a test summary or
 * the final error usually is, never reached the observer. This replaces the end of `stdout` with the end of that file
 * and marks the cut with the real size. `stdout` grows only by the two markers, so the stored row and the observer
 * prompt keep their current bounds. The tail is the share of the field the observer prompt keeps from the end.
 *
 * The observer prompt keeps the head and the tail of the whole serialized response and drops its middle, which is
 * where the cut point lands. So the note saying Claude Code cut the output, and by how much, opens `stdout`: the
 * prompt always keeps the head of the field. A short marker still sits at the cut point itself.
 */
const TAIL_CHARS = Math.floor(OBS_PROMPT_FIELD_MAX_CHARS * OBS_PROMPT_FIELD_TAIL_RATIO);

/** Only a file Claude Code wrote under its own `projects/.../tool-results/` directory is read. */
function isClaudeToolResult(file: string): boolean {
  const projects = realpathSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects'));
  const relative = path.relative(projects, file);
  if (relative === '' || path.isAbsolute(relative) || relative.split(path.sep)[0] === '..') return false;
  return path.basename(path.dirname(file)) === 'tool-results';
}

export function withPersistedOutputTail(toolResponse: unknown): unknown {
  if (!toolResponse || typeof toolResponse !== 'object' || Array.isArray(toolResponse)) return toolResponse;
  const response = toolResponse as Record<string, unknown>;
  const { stdout, persistedOutputPath } = response;
  if (typeof stdout !== 'string' || typeof persistedOutputPath !== 'string' || persistedOutputPath === '') return toolResponse;
  try {
    const file = realpathSync(persistedOutputPath);
    if (!isClaudeToolResult(file)) return toolResponse;
    const stat = statSync(file);
    const size = stat.size;
    if (!stat.isFile() || size <= Buffer.byteLength(stdout)) return toolResponse;
    const fd = openSync(file, 'r');
    try {
      const { head } = retainTextHeadTail(stdout, stdout.length - Math.min(TAIL_CHARS, Math.floor(stdout.length / 2)), 0);
      const headBytes = Buffer.byteLength(head);
      const tailStart = Math.max(headBytes, size - (stdout.length - head.length));
      const buffer = Buffer.alloc(size - tailStart);
      const read = readSync(fd, buffer, 0, buffer.length, tailStart);
      // Start the tail on a whole UTF-8 character.
      let skip = 0;
      while (skip < read && (buffer[skip] & 0xc0) === 0x80) skip++;
      const tail = buffer.toString('utf8', skip, read);
      const elidedBytes = tailStart + skip - headBytes;
      return {
        ...response,
        stdout: `<harness-cut original_size_bytes="${size}" elided_bytes="${elidedBytes}" kept="head and end" />\n`
          + `${head}\n... <elided bytes="${elidedBytes}" reason="harness-cut" /> ...\n${tail}`,
      };
    } finally {
      closeSync(fd);
    }
  } catch (error: unknown) {
    logger.debug('HOOK', 'Persisted tool output unreadable; keeping the cut stdout', {
      error: error instanceof Error ? error.message : String(error),
    });
    return toolResponse;
  }
}
