/**
 * OpenCode Platform Adapter Tests
 *
 * Tests for the OpenCode hook input normalization and output formatting.
 * The adapter translates between OpenCode's event format and claude-mem's
 * internal NormalizedHookInput/HookResult types.
 */

import { describe, it, expect } from 'bun:test';
import { opencodeAdapter } from '../src/cli/adapters/opencode';

describe('OpenCode Adapter', () => {
  describe('normalizeInput', () => {
    it('extracts sessionId from sessionId field', () => {
      const result = opencodeAdapter.normalizeInput({ sessionId: 'oc-123' });
      expect(result.sessionId).toBe('oc-123');
    });

    it('falls back to session_id', () => {
      const result = opencodeAdapter.normalizeInput({ session_id: 'oc-456' });
      expect(result.sessionId).toBe('oc-456');
    });

    it('falls back to id', () => {
      const result = opencodeAdapter.normalizeInput({ id: 'oc-789' });
      expect(result.sessionId).toBe('oc-789');
    });

    it('falls back to conversation_id', () => {
      const result = opencodeAdapter.normalizeInput({ conversation_id: 'conv-1' });
      expect(result.sessionId).toBe('conv-1');
    });

    it('extracts cwd from cwd field', () => {
      const result = opencodeAdapter.normalizeInput({ cwd: '/home/user/project' });
      expect(result.cwd).toBe('/home/user/project');
    });

    it('falls back to directory for cwd', () => {
      const result = opencodeAdapter.normalizeInput({ directory: '/tmp/dir' });
      expect(result.cwd).toBe('/tmp/dir');
    });

    it('falls back to worktree for cwd', () => {
      const result = opencodeAdapter.normalizeInput({ worktree: '/workspace' });
      expect(result.cwd).toBe('/workspace');
    });

    it('defaults cwd to process.cwd() when missing', () => {
      const result = opencodeAdapter.normalizeInput({});
      expect(result.cwd).toBe(process.cwd());
    });

    it('extracts prompt from prompt field', () => {
      const result = opencodeAdapter.normalizeInput({ prompt: 'hello world' });
      expect(result.prompt).toBe('hello world');
    });

    it('falls back to query for prompt', () => {
      const result = opencodeAdapter.normalizeInput({ query: 'search this' });
      expect(result.prompt).toBe('search this');
    });

    it('falls back to input for prompt', () => {
      const result = opencodeAdapter.normalizeInput({ input: 'some input' });
      expect(result.prompt).toBe('some input');
    });

    it('falls back to message for prompt', () => {
      const result = opencodeAdapter.normalizeInput({ message: 'a message' });
      expect(result.prompt).toBe('a message');
    });

    it('extracts tool fields', () => {
      const result = opencodeAdapter.normalizeInput({
        toolName: 'read_file',
        toolInput: { path: '/foo' },
        toolResponse: { content: 'bar' },
      });
      expect(result.toolName).toBe('read_file');
      expect(result.toolInput).toEqual({ path: '/foo' });
      expect(result.toolResponse).toEqual({ content: 'bar' });
    });

    it('falls back to snake_case tool fields', () => {
      const result = opencodeAdapter.normalizeInput({
        tool_name: 'write_file',
        tool_input: { data: 'x' },
        tool_response: { ok: true },
      });
      expect(result.toolName).toBe('write_file');
      expect(result.toolInput).toEqual({ data: 'x' });
      expect(result.toolResponse).toEqual({ ok: true });
    });

    it('falls back to short aliases for tool fields', () => {
      const result = opencodeAdapter.normalizeInput({
        tool: 'bash',
        args: { cmd: 'ls' },
        result: { stdout: 'file.txt' },
      });
      expect(result.toolName).toBe('bash');
      expect(result.toolInput).toEqual({ cmd: 'ls' });
      expect(result.toolResponse).toEqual({ stdout: 'file.txt' });
    });

    it('extracts transcriptPath and filePath', () => {
      const result = opencodeAdapter.normalizeInput({
        transcriptPath: '/tmp/transcript.json',
        filePath: '/src/main.ts',
      });
      expect(result.transcriptPath).toBe('/tmp/transcript.json');
      expect(result.filePath).toBe('/src/main.ts');
    });

    it('falls back to snake_case for transcriptPath and filePath', () => {
      const result = opencodeAdapter.normalizeInput({
        transcript_path: '/tmp/t.json',
        file_path: '/src/f.ts',
      });
      expect(result.transcriptPath).toBe('/tmp/t.json');
      expect(result.filePath).toBe('/src/f.ts');
    });

    it('extracts edits field', () => {
      const edits = [{ file: 'a.ts', changes: [] }];
      const result = opencodeAdapter.normalizeInput({ edits });
      expect(result.edits).toEqual(edits);
    });

    it('handles null/undefined input gracefully', () => {
      const result = opencodeAdapter.normalizeInput(null);
      expect(result.cwd).toBe(process.cwd());
      expect(result.sessionId).toBeUndefined();
    });

    it('handles undefined input gracefully', () => {
      const result = opencodeAdapter.normalizeInput(undefined);
      expect(result.cwd).toBe(process.cwd());
    });
  });

  describe('formatOutput', () => {
    it('returns hookSpecificOutput when present', () => {
      const result = opencodeAdapter.formatOutput({
        hookSpecificOutput: { context: 'memory data' },
        continue: true,
      } as any);
      expect(result).toHaveProperty('hookSpecificOutput');
      expect((result as any).hookSpecificOutput).toEqual({ context: 'memory data' });
    });

    it('includes systemMessage with hookSpecificOutput when present', () => {
      const result = opencodeAdapter.formatOutput({
        hookSpecificOutput: { data: 'x' },
        systemMessage: 'injected context',
      } as any);
      expect((result as any).systemMessage).toBe('injected context');
    });

    it('returns continue and suppressOutput for normal results', () => {
      const result = opencodeAdapter.formatOutput({
        continue: true,
        suppressOutput: false,
      } as any);
      expect((result as any).continue).toBe(true);
      expect((result as any).suppressOutput).toBe(false);
    });

    it('defaults continue to true and suppressOutput to true', () => {
      const result = opencodeAdapter.formatOutput({} as any);
      expect((result as any).continue).toBe(true);
      expect((result as any).suppressOutput).toBe(true);
    });

    it('includes systemMessage in normal output when present', () => {
      const result = opencodeAdapter.formatOutput({
        systemMessage: 'hello',
      } as any);
      expect((result as any).systemMessage).toBe('hello');
    });

    it('omits systemMessage when not present', () => {
      const result = opencodeAdapter.formatOutput({
        continue: true,
      } as any);
      expect(result).not.toHaveProperty('systemMessage');
    });
  });
});
