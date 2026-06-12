import { describe, expect, it } from 'bun:test';
import { kimiAdapter } from '../../../src/cli/adapters/kimi.js';

describe('kimiAdapter', () => {
  describe('normalizeInput', () => {
    it('extracts cwd from payload, env fallback, or process cwd', () => {
      const input = kimiAdapter.normalizeInput({ cwd: '/tmp/project' });
      expect(input.cwd).toBe('/tmp/project');
    });

    it('extracts session id from payload or env', () => {
      const input = kimiAdapter.normalizeInput({ session_id: 'sess-123' });
      expect(input.sessionId).toBe('sess-123');
    });

    it('normalizes prompt from multiple field names', () => {
      expect(kimiAdapter.normalizeInput({ prompt: 'hello' }).prompt).toBe('hello');
      expect(kimiAdapter.normalizeInput({ query: 'hi' }).prompt).toBe('hi');
      expect(kimiAdapter.normalizeInput({ input: 'yo' }).prompt).toBe('yo');
      expect(kimiAdapter.normalizeInput({ message: 'sup' }).prompt).toBe('sup');
    });

    it('captures tool use fields', () => {
      const input = kimiAdapter.normalizeInput({
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { stdout: 'file.txt' },
      });
      expect(input.toolName).toBe('Bash');
      expect(input.toolInput).toEqual({ command: 'ls' });
      expect(input.toolResponse).toEqual({ stdout: 'file.txt' });
    });

    it('maps startup/resume/clear session sources', () => {
      expect(kimiAdapter.normalizeInput({ source: 'startup' }).sessionSource).toBe('startup');
      expect(kimiAdapter.normalizeInput({ source: 'resume' }).sessionSource).toBe('resume');
      expect(kimiAdapter.normalizeInput({ source: 'clear' }).sessionSource).toBe('clear');
      expect(kimiAdapter.normalizeInput({ source: 'other' }).sessionSource).toBeUndefined();
    });
  });

  describe('formatOutput', () => {
    it('emits continue true by default', () => {
      const output = kimiAdapter.formatOutput({});
      expect(output).toEqual({ continue: true });
    });

    it('passes through suppressOutput and systemMessage', () => {
      const output = kimiAdapter.formatOutput({
        suppressOutput: true,
        systemMessage: 'hello',
      });
      expect(output).toEqual({ continue: true, suppressOutput: true, systemMessage: 'hello' });
    });

    it('maps hookSpecificOutput.additionalContext to top-level additionalContext', () => {
      const output = kimiAdapter.formatOutput({
        hookSpecificOutput: {
          hookEventName: 'context',
          additionalContext: '# memory',
        },
      });
      expect(output).toEqual({ continue: true, additionalContext: '# memory' });
    });
  });
});
