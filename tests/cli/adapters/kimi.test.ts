import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { deriveKimiTranscriptPath, kimiAdapter } from '../../../src/cli/adapters/kimi.js';

const ORIGINAL_HOME = process.env.KIMI_CODE_HOME;

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.KIMI_CODE_HOME;
  else process.env.KIMI_CODE_HOME = ORIGINAL_HOME;
});

function makeScratchHome(): string {
  const dir = path.join(tmpdir(), `kimi-adapter-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.KIMI_CODE_HOME = dir;
  return dir;
}

describe('kimiAdapter.normalizeInput', () => {
  test('normalizes a PostToolUse payload', () => {
    const input = kimiAdapter.normalizeInput({
      hook_event_name: 'PostToolUse',
      session_id: 'session_abc',
      cwd: process.cwd(),
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { stdout: 'ok' },
    });
    expect(input.sessionId).toBe('session_abc');
    expect(input.toolName).toBe('Bash');
    expect(input.toolInput).toEqual({ command: 'ls' });
    expect(input.toolResponse).toEqual({ stdout: 'ok' });
  });

  test('maps SessionStart source startup|resume, drops unknown values', () => {
    const base = { hook_event_name: 'SessionStart', session_id: 's1', cwd: process.cwd() };
    expect(kimiAdapter.normalizeInput({ ...base, source: 'startup' }).sessionSource).toBe('startup');
    expect(kimiAdapter.normalizeInput({ ...base, source: 'resume' }).sessionSource).toBe('resume');
    expect(kimiAdapter.normalizeInput({ ...base, source: 'archive' }).sessionSource).toBeUndefined();
  });

  test('rejects missing session_id', () => {
    expect(() => kimiAdapter.normalizeInput({ cwd: process.cwd() })).toThrow();
  });

  test('derives transcriptPath from the sessions tree', () => {
    const home = makeScratchHome();
    const wire = path.join(home, 'sessions', 'wd_proj_abc123', 'session_abc', 'agents', 'main', 'wire.jsonl');
    mkdirSync(path.dirname(wire), { recursive: true });
    writeFileSync(wire, '{"type":"metadata"}\n');
    const input = kimiAdapter.normalizeInput({ session_id: 'session_abc', cwd: process.cwd() });
    expect(input.transcriptPath).toBe(wire);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('kimiAdapter.formatOutput', () => {
  test('passes additionalContext through as raw text for stdout injection', () => {
    expect(kimiAdapter.formatOutput({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'memory digest' } }))
      .toBe('memory digest');
  });

  test('returns empty string otherwise', () => {
    expect(kimiAdapter.formatOutput({})).toBe('');
  });
});

describe('deriveKimiTranscriptPath', () => {
  test('returns undefined when the sessions root is missing', () => {
    makeScratchHome();
    expect(deriveKimiTranscriptPath('session_nope')).toBeUndefined();
  });
});
