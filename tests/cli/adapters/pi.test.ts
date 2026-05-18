import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { piAdapter } from '../../../src/cli/adapters/pi.js';
import { AdapterRejectedInput } from '../../../src/cli/adapters/errors.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pi-adapter-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('piAdapter.normalizeInput', () => {
  it('accepts canonical NormalizedHookInput camelCase keys', () => {
    const input = piAdapter.normalizeInput({
      sessionId: '019e28db-1234',
      cwd: tmpDir,
      toolName: 'read',
      toolInput: { path: '/etc/hosts' },
      toolResponse: { content: 'localhost' },
      prompt: 'show me the hosts file',
      filePath: '/etc/hosts',
      agentId: 'pane-uuid-1',
      agentType: 'pi-subagent',
      model: 'sonnet',
    });

    expect(input.sessionId).toBe('019e28db-1234');
    expect(input.cwd).toBe(tmpDir);
    expect(input.toolName).toBe('read');
    expect(input.toolInput).toEqual({ path: '/etc/hosts' });
    expect(input.toolResponse).toEqual({ content: 'localhost' });
    expect(input.prompt).toBe('show me the hosts file');
    expect(input.filePath).toBe('/etc/hosts');
    expect(input.agentId).toBe('pane-uuid-1');
    expect(input.agentType).toBe('pi-subagent');
    expect(input.model).toBe('sonnet');
  });

  it('accepts Pi-native snake_case keys', () => {
    const input = piAdapter.normalizeInput({
      session_id: '019e28db',
      cwd: tmpDir,
      tool_name: 'bash',
      tool_input: { command: 'ls' },
      tool_response: { output: 'a b c' },
      file_path: '/tmp/x',
      agent_id: 'A',
      agent_type: 'pi',
    });

    expect(input.sessionId).toBe('019e28db');
    expect(input.toolName).toBe('bash');
    expect(input.toolInput).toEqual({ command: 'ls' });
    expect(input.toolResponse).toEqual({ output: 'a b c' });
    expect(input.filePath).toBe('/tmp/x');
    expect(input.agentId).toBe('A');
    expect(input.agentType).toBe('pi');
  });

  it('normalizes sessionId via the safe-coercion helper', () => {
    // Empty / whitespace-only strings collapse to the 'unknown' sentinel
    // (matches rawAdapter precedent) so the non-optional sessionId
    // contract on NormalizedHookInput is always satisfied.
    expect(piAdapter.normalizeInput({ cwd: tmpDir, sessionId: '   ' }).sessionId).toBe('unknown');
    expect(piAdapter.normalizeInput({ cwd: tmpDir, sessionId: '' }).sessionId).toBe('unknown');

    // Whitespace around a valid id is trimmed.
    expect(
      piAdapter.normalizeInput({ cwd: tmpDir, sessionId: '  019e28db  ' }).sessionId,
    ).toBe('019e28db');

    // Numeric session ids (some Pi forks pass these) are coerced to string.
    expect(
      piAdapter.normalizeInput({ cwd: tmpDir, sessionId: 42 as unknown as string }).sessionId,
    ).toBe('42');

    // Non-string / non-number shapes collapse to 'unknown'.
    expect(
      piAdapter.normalizeInput({ cwd: tmpDir, sessionId: { id: 'x' } as unknown as string }).sessionId,
    ).toBe('unknown');
    expect(
      piAdapter.normalizeInput({ cwd: tmpDir, sessionId: true as unknown as string }).sessionId,
    ).toBe('unknown');
  });

  it('also accepts alternate Pi event keys (input/output/path)', () => {
    const input = piAdapter.normalizeInput({
      sessionUuid: 'abc',
      workingDirectory: tmpDir,
      toolType: 'write',
      input: { content: 'hi' },
      output: { bytes: 2 },
      path: '/tmp/y',
    });

    expect(input.sessionId).toBe('abc');
    expect(input.cwd).toBe(tmpDir);
    expect(input.toolName).toBe('write');
    expect(input.toolInput).toEqual({ content: 'hi' });
    expect(input.toolResponse).toEqual({ bytes: 2 });
    expect(input.filePath).toBe('/tmp/y');
  });

  it('defaults agentType to "pi" when missing', () => {
    const input = piAdapter.normalizeInput({ cwd: tmpDir });
    expect(input.agentType).toBe('pi');
  });

  it('honors explicit agentType override (e.g. pi-subagent)', () => {
    const input = piAdapter.normalizeInput({ cwd: tmpDir, agentType: 'pi-subagent' });
    expect(input.agentType).toBe('pi-subagent');
  });

  it('rejects oversized agentType strings via pickAgentField hardening', () => {
    const oversized = 'x'.repeat(200);
    const input = piAdapter.normalizeInput({ cwd: tmpDir, agentType: oversized });
    expect(input.agentType).toBe('pi');
  });

  it('falls back to process.cwd() when cwd is omitted', () => {
    const input = piAdapter.normalizeInput({ sessionId: 'X' });
    expect(input.cwd).toBe(process.cwd());
  });

  it('throws AdapterRejectedInput for invalid cwd (empty string)', () => {
    expect(() => piAdapter.normalizeInput({ cwd: '' })).toThrow(AdapterRejectedInput);
  });

  it('throws AdapterRejectedInput when cwd is a non-string (and process.cwd() fallback would not apply)', () => {
    // isValidCwd rejects non-string cwd; the fallback chain
    // (cwd ?? workingDirectory ?? process.cwd()) only fires for nullish, so
    // explicitly passing a number triggers the guard.
    expect(() => piAdapter.normalizeInput({ cwd: 42 as unknown as string })).toThrow(AdapterRejectedInput);
  });

  it('forwards explicit transcriptPath verbatim', () => {
    const input = piAdapter.normalizeInput({
      cwd: tmpDir,
      sessionId: 'abc',
      transcriptPath: '/explicit/path.jsonl',
    });
    expect(input.transcriptPath).toBe('/explicit/path.jsonl');
  });

  it('accepts snake_case transcript_path', () => {
    const input = piAdapter.normalizeInput({
      cwd: tmpDir,
      sessionId: 'abc',
      transcript_path: '/snake/path.jsonl',
    });
    expect(input.transcriptPath).toBe('/snake/path.jsonl');
  });

  it('forwards metadata, model, permissionMode, lastAssistantMessage, turnId', () => {
    const input = piAdapter.normalizeInput({
      cwd: tmpDir,
      sessionId: 'abc',
      metadata: { exitReason: 'natural' },
      model: 'opus',
      permissionMode: 'allow',
      lastAssistantMessage: 'all done',
      turnId: 'turn-42',
    });
    expect(input.metadata).toEqual({ exitReason: 'natural' });
    expect(input.model).toBe('opus');
    expect(input.permissionMode).toBe('allow');
    expect(input.lastAssistantMessage).toBe('all done');
    expect(input.turnId).toBe('turn-42');
  });
});

describe('piAdapter.formatOutput', () => {
  it('preserves continue=true by default', () => {
    const out = piAdapter.formatOutput({}) as Record<string, unknown>;
    expect(out.continue).toBe(true);
  });

  it('honors explicit continue=false', () => {
    const out = piAdapter.formatOutput({ continue: false }) as Record<string, unknown>;
    expect(out.continue).toBe(false);
  });

  it('passes through hookSpecificOutput', () => {
    const out = piAdapter.formatOutput({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'prior context',
      },
    }) as Record<string, unknown>;
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext: 'prior context',
    });
  });

  it('passes through systemMessage', () => {
    const out = piAdapter.formatOutput({ systemMessage: 'hint' }) as Record<string, unknown>;
    expect(out.systemMessage).toBe('hint');
  });

  it('passes through suppressOutput when set', () => {
    const out = piAdapter.formatOutput({ suppressOutput: true }) as Record<string, unknown>;
    expect(out.suppressOutput).toBe(true);
  });

  it('omits suppressOutput when undefined', () => {
    const out = piAdapter.formatOutput({}) as Record<string, unknown>;
    expect('suppressOutput' in out).toBe(false);
  });
});
