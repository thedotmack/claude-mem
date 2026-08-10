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

    it('coerces a ContentPart[] prompt array to a string', () => {
      const input = kimiAdapter.normalizeInput({
        prompt: [{ type: 'text', text: 'hello' }, { text: 'world' }],
      });
      expect(input.prompt).toBe('hello\nworld');
    });

    it('coerces a prompt object with a text field to a string', () => {
      const input = kimiAdapter.normalizeInput({ prompt: { text: 'hello world' } });
      expect(input.prompt).toBe('hello world');
    });

    it('falls back to undefined when prompt is an unsupported object', () => {
      const input = kimiAdapter.normalizeInput({ prompt: { foo: 'bar' } });
      expect(input.prompt).toBeUndefined();
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
    it('emits nothing when there is no context or system message', () => {
      const output = kimiAdapter.formatOutput({});
      expect(output).toBeUndefined();
    });

    it('passes through systemMessage', () => {
      const output = kimiAdapter.formatOutput({
        systemMessage: 'hello',
      });
      expect(output).toEqual({ continue: true, systemMessage: 'hello' });
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
