import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { kimiAdapter } from '../../../src/cli/adapters/kimi.js';
import { synthesizeKimiTranscript } from '../../../src/cli/adapters/kimi-transcript.js';

describe('kimiAdapter', () => {
  describe('normalizeInput', () => {
    it('extracts cwd from payload, env fallback, or process cwd', () => {
      const input = kimiAdapter.normalizeInput({ cwd: '/tmp/project', session_id: 's1' });
      expect(input.cwd).toBe('/tmp/project');
    });

    it('extracts session id from payload or env', () => {
      const input = kimiAdapter.normalizeInput({ session_id: 'sess-123' });
      expect(input.sessionId).toBe('sess-123');
    });

    it('rejects input without a session id', () => {
      expect(() => kimiAdapter.normalizeInput({ cwd: '/tmp/project' })).toThrow();
    });

    it('normalizes prompt from multiple field names', () => {
      expect(kimiAdapter.normalizeInput({ session_id: 's', prompt: 'hello' }).prompt).toBe('hello');
      expect(kimiAdapter.normalizeInput({ session_id: 's', query: 'hi' }).prompt).toBe('hi');
      expect(kimiAdapter.normalizeInput({ session_id: 's', input: 'yo' }).prompt).toBe('yo');
      expect(kimiAdapter.normalizeInput({ session_id: 's', message: 'sup' }).prompt).toBe('sup');
    });

    it('coerces a ContentPart[] prompt array to a string', () => {
      const input = kimiAdapter.normalizeInput({
        session_id: 's',
        prompt: [{ type: 'text', text: 'hello' }, { text: 'world' }],
      });
      expect(input.prompt).toBe('hello\nworld');
    });

    it('coerces a prompt object with a text field to a string', () => {
      const input = kimiAdapter.normalizeInput({ session_id: 's', prompt: { text: 'hello world' } });
      expect(input.prompt).toBe('hello world');
    });

    it('falls back to undefined when prompt is an unsupported object', () => {
      const input = kimiAdapter.normalizeInput({ session_id: 's', prompt: { foo: 'bar' } });
      expect(input.prompt).toBeUndefined();
    });

    it('captures tool use fields', () => {
      const input = kimiAdapter.normalizeInput({
        session_id: 's',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { stdout: 'file.txt' },
      });
      expect(input.toolName).toBe('Bash');
      expect(input.toolInput).toEqual({ command: 'ls' });
      expect(input.toolResponse).toEqual({ stdout: 'file.txt' });
    });

    // Verified against live Kimi Code PostToolUse payloads: the tool result
    // arrives as tool_output, not Claude Code's tool_response.
    it('maps Kimi tool_output to toolResponse when tool_response is absent', () => {
      const input = kimiAdapter.normalizeInput({
        session_id: 's',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_output: { stdout: 'ok' },
      });
      expect(input.toolResponse).toEqual({ stdout: 'ok' });
    });

    it('prefers tool_response over tool_output when both are present', () => {
      const input = kimiAdapter.normalizeInput({
        session_id: 's',
        tool_response: { stdout: 'canonical' },
        tool_output: { stdout: 'legacy' },
      });
      expect(input.toolResponse).toEqual({ stdout: 'canonical' });
    });

    it('maps startup/resume session sources', () => {
      expect(kimiAdapter.normalizeInput({ session_id: 's', source: 'startup' }).sessionSource).toBe('startup');
      expect(kimiAdapter.normalizeInput({ session_id: 's', source: 'resume' }).sessionSource).toBe('resume');
      expect(kimiAdapter.normalizeInput({ session_id: 's', source: 'other' }).sessionSource).toBeUndefined();
    });
  });

  describe('formatOutput', () => {
    it('emits nothing when there is no context to inject', () => {
      expect(kimiAdapter.formatOutput({})).toBeUndefined();
      expect(kimiAdapter.formatOutput({ systemMessage: 'hello' })).toBeUndefined();
    });

    // Kimi appends raw hook stdout to the model context; a JSON envelope
    // would be injected verbatim, so context must go out as plain text.
    it('emits additionalContext as plain text, not a JSON envelope', () => {
      const output = kimiAdapter.formatOutput({
        hookSpecificOutput: {
          hookEventName: 'context',
          additionalContext: '# memory',
        },
      });
      expect(output).toBe('# memory');
    });
  });
});

describe('synthesizeKimiTranscript', () => {
  function withFakeKimiHome(fn: (home: string) => void): void {
    const home = mkdtempSync(path.join(tmpdir(), 'kimi-home-'));
    const prev = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = home;
    try {
      fn(home);
    } finally {
      if (prev === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  }

  function writeWire(home: string, sessionId: string, lines: unknown[]): void {
    const dir = path.join(home, 'sessions', 'wd_test', `session_${sessionId}`, 'agents', 'main');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'wire.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
  }

  it('returns null when the session wire file does not exist', () => {
    withFakeKimiHome(() => {
      expect(synthesizeKimiTranscript('missing-session')).toBeNull();
    });
  });

  it('converts user messages and assistant text parts, skipping think parts', () => {
    withFakeKimiHome((home) => {
      writeWire(home, 'abc', [
        { type: 'metadata', protocol_version: '1.5' },
        {
          type: 'context.append_message',
          message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
        },
        {
          type: 'context.append_loop_event',
          event: { type: 'content.part', part: { type: 'think', think: 'hmm' } },
        },
        {
          type: 'context.append_loop_event',
          event: { type: 'content.part', part: { type: 'text', text: 'Done — fixed it.' } },
        },
      ]);

      const out = synthesizeKimiTranscript('abc');
      expect(out).not.toBeNull();
      const lines = readFileSync(out!, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toEqual({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
      });
      expect(lines[1]).toEqual({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done — fixed it.' }] },
      });
    });
  });

  it('normalizeInput synthesizes transcriptPath for Stop events', () => {
    withFakeKimiHome((home) => {
      writeWire(home, 'stop-sess', [
        {
          type: 'context.append_loop_event',
          event: { type: 'content.part', part: { type: 'text', text: 'final answer' } },
        },
      ]);
      const input = kimiAdapter.normalizeInput({
        session_id: 'stop-sess',
        hook_event_name: 'Stop',
        cwd: '/tmp/project',
        stop_hook_active: false,
      });
      expect(input.transcriptPath).toBeDefined();
      const content = readFileSync(input.transcriptPath!, 'utf-8');
      expect(content).toContain('final answer');
    });
  });
});
