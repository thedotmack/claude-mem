/**
 * A session that ends mid-tool-call can leave a transcript whose assistant
 * turns are ALL tool_use blocks with no text. The Stop hook then had nothing
 * to summarize and silently skipped the session. extractLastMessageFromJsonl
 * now falls back to naming the most recent turn's tools, and only when no
 * assistant turn carries any text at all.
 */
import { describe, it, expect } from 'bun:test';
import { extractLastMessageFromJsonl } from '../../src/shared/transcript-parser.js';

const assistantTurn = (content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } });
const userTurn = (text: string) => JSON.stringify({ type: 'user', message: { content: text } });

describe('extractLastMessageFromJsonl — session ended mid-tool-call', () => {
  it('names the most recent turn\'s tools when every assistant turn is tool_use only', () => {
    const longCommand = `npm run build -- --verbose ${'x'.repeat(100)}`;
    const transcript = [
      userTurn('fix the build'),
      assistantTurn([{ type: 'tool_use', name: 'Read', input: { file_path: 'src/index.ts' } }]),
      assistantTurn([
        { type: 'tool_use', name: 'Bash', input: { command: longCommand } },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'src/build.ts' } },
        { type: 'tool_use', name: 'TodoWrite', input: { todos: [] } },
      ]),
    ].join('\n');

    expect(extractLastMessageFromJsonl(transcript, 'assistant', true)).toBe(
      `[Session ended mid-task. Last tools used: Bash(${longCommand.slice(0, 60)}), Edit(src/build.ts), TodoWrite]`
    );
  });

});
