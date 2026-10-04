import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

  test('maps Read path without mutating its original input or dropping read options', () => {
    const rawInput = { path: 'src/owned.ts', line_offset: 2, n_lines: 3, column_offset: 4, max_chars: 500 };
    const before = { ...rawInput };
    const normalized = kimiAdapter.normalizeInput({ session_id: 'read-path', cwd: process.cwd(),
      tool_name: 'Read', tool_input: rawInput });
    expect(normalized.toolInput).toEqual({ ...before, file_path: before.path });
    expect(normalized.toolInput).not.toBe(rawInput);
    expect(rawInput).toEqual(before);
    const write = kimiAdapter.normalizeInput({ session_id: 'write-path', cwd: process.cwd(),
      tool_name: 'Write', tool_input: rawInput });
    expect(write.toolInput).toBe(rawInput);
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

// Payload shapes pinned from Kimi Code's source (tests/fixtures/hosts/kimi-code-hooks.json).
describe('kimiAdapter against Kimi Code payloads', () => {
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dir, '..', '..', 'fixtures', 'hosts', 'kimi-code-hooks.json'), 'utf-8'),
  ) as { payloads: Record<string, Record<string, unknown>> };

  test('reads tool_output and tool_call_id from PostToolUse', () => {
    const input = kimiAdapter.normalizeInput(fixture.payloads.PostToolUse);
    expect(input.toolName).toBe('Bash');
    expect(input.toolInput).toEqual({ command: 'ls' });
    expect(input.toolResponse).toBe('README.md\nsrc\n');
    expect(input.toolUseId).toBe('call_1');
  });

  test('records the error of a PostToolUseFailure as the tool response', () => {
    const input = kimiAdapter.normalizeInput(fixture.payloads.PostToolUseFailure);
    expect(input.toolResponse).toEqual(fixture.payloads.PostToolUseFailure.error);
    expect(input.hookEventName).toBe('PostToolUseFailure');
  });

  test('joins the text parts of a ContentPart[] prompt', () => {
    expect(kimiAdapter.normalizeInput(fixture.payloads.UserPromptSubmit).prompt).toBe('fix the login redirect');
    const mixed = {
      ...fixture.payloads.UserPromptSubmit,
      prompt: [
        { type: 'text', text: 'compare these' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: 'two screenshots' },
      ],
    };
    expect(kimiAdapter.normalizeInput(mixed).prompt).toBe('compare these\ntwo screenshots');
  });

  test('leaves an image-only prompt empty, and still takes a plain string', () => {
    const base = fixture.payloads.UserPromptSubmit;
    expect(kimiAdapter.normalizeInput({ ...base, prompt: [{ type: 'image_url', image_url: { url: 'x' } }] }).prompt)
      .toBeUndefined();
    expect(kimiAdapter.normalizeInput({ ...base, prompt: 'plain text' }).prompt).toBe('plain text');
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

  test('rejects path-traversal sessionId containing ..', () => {
    const home = makeScratchHome();
    const safeId = 'session_abc';
    const wire = path.join(home, 'sessions', 'wd_proj_abc123', safeId, 'agents', 'main', 'wire.jsonl');
    mkdirSync(path.dirname(wire), { recursive: true });
    writeFileSync(wire, '{}\n');
    expect(deriveKimiTranscriptPath('../session_abc')).toBeUndefined();
    expect(deriveKimiTranscriptPath('foo/../session_abc')).toBeUndefined();
  });

  test('rejects absolute-path sessionId', () => {
    const home = makeScratchHome();
    const wire = path.join(home, 'sessions', 'wd_proj_abc123', 'session_abc', 'agents', 'main', 'wire.jsonl');
    mkdirSync(path.dirname(wire), { recursive: true });
    writeFileSync(wire, '{}\n');
    expect(deriveKimiTranscriptPath('/etc/passwd')).toBeUndefined();
    expect(deriveKimiTranscriptPath(path.join(home, 'sessions', 'wd_proj_abc123', 'session_abc'))).toBeUndefined();
  });

  test('memoizes the result so repeated calls do not rescan the sessions directory', () => {
    const home = makeScratchHome();
    const wire = path.join(home, 'sessions', 'wd_proj_abc123', 'session_memo', 'agents', 'main', 'wire.jsonl');
    mkdirSync(path.dirname(wire), { recursive: true });
    writeFileSync(wire, '{}\n');

    const first = deriveKimiTranscriptPath('session_memo');
    expect(first).toBe(wire);

    // Remove the file after the first lookup; a memoized result still returns
    // the original path, while a non-memoized scan would return undefined.
    rmSync(wire);
    const second = deriveKimiTranscriptPath('session_memo');
    expect(second).toBe(wire);
  });
});
