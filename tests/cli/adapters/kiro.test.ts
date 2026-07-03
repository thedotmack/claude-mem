import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { kiroAdapter } from '../../../src/cli/adapters/kiro.js';
import { AdapterRejectedInput } from '../../../src/cli/adapters/errors.js';

const FIXTURES_DIR = join(import.meta.dir, '../../fixtures/kiro');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8'));
}

// Live-captured contract (kiro-cli 2.11.0): the stdin payload has NO
// session_id — the session UUID reaches the hook process via KIRO_SESSION_ID.
const ENV_SESSION_ID = '7e14987c-2fb5-4d79-950a-06c4cb387f89';
let previousEnvSessionId: string | undefined;

beforeEach(() => {
  previousEnvSessionId = process.env.KIRO_SESSION_ID;
  process.env.KIRO_SESSION_ID = ENV_SESSION_ID;
});

afterEach(() => {
  if (previousEnvSessionId === undefined) {
    delete process.env.KIRO_SESSION_ID;
  } else {
    process.env.KIRO_SESSION_ID = previousEnvSessionId;
  }
});

describe('kiroAdapter.normalizeInput', () => {
  it('normalizes the agentSpawn envelope, taking the session id from KIRO_SESSION_ID', () => {
    const input = kiroAdapter.normalizeInput(loadFixture('agent-spawn.json'));

    expect(input.sessionId).toBe(ENV_SESSION_ID);
    expect(input.cwd).toBe('/tmp/kiro-e2e-project');
    expect(input.toolName).toBeUndefined();
    expect(input.transcriptPath).toBeUndefined();
  });

  it('prefers a payload session_id over the env var if a future Kiro adds one', () => {
    const input = kiroAdapter.normalizeInput({ cwd: '/tmp', session_id: 'payload-wins' });

    expect(input.sessionId).toBe('payload-wins');
  });

  it('extracts prompt from userPromptSubmit', () => {
    const input = kiroAdapter.normalizeInput(loadFixture('user-prompt-submit.json'));

    expect(input.prompt).toBe('Fix the login timeout bug in the auth service');
  });

  it('maps fs_write → Write and aliases tool_input.path to file_path', () => {
    const input = kiroAdapter.normalizeInput(loadFixture('post-tool-use-fs-write.json'));

    expect(input.toolName).toBe('Write');
    const toolInput = input.toolInput as Record<string, unknown>;
    // file_path is what the worker's file extraction keys on; the original
    // Kiro field must survive so observations keep the exact reported input.
    expect(toolInput.file_path).toBe('/tmp/kiro-e2e-project/src/auth.ts');
    expect(toolInput.path).toBe('/tmp/kiro-e2e-project/src/auth.ts');
    expect(toolInput.command).toBe('create');
    expect(input.toolResponse).toEqual({ success: true, result: [''] });
  });

  it('maps fs_read → Read, extracting file_path from the batched operations array', () => {
    const input = kiroAdapter.normalizeInput(loadFixture('post-tool-use-fs-read.json'));

    expect(input.toolName).toBe('Read');
    const toolInput = input.toolInput as Record<string, unknown>;
    expect(toolInput.file_path).toBe('/tmp/kiro-e2e-project/src/auth.ts');
    // The original batched shape must survive alongside the alias.
    expect(Array.isArray(toolInput.operations)).toBe(true);
  });

  it('takes the first path when fs_read batches multiple operations', () => {
    const input = kiroAdapter.normalizeInput({
      cwd: '/tmp',
      tool_name: 'fs_read',
      tool_input: { operations: [{ mode: 'Directory' }, { mode: 'Line', path: '/a.ts' }, { mode: 'Line', path: '/b.ts' }] },
    });

    expect((input.toolInput as Record<string, unknown>).file_path).toBe('/a.ts');
  });

  it('maps execute_bash → Bash without touching tool_input', () => {
    const input = kiroAdapter.normalizeInput(loadFixture('post-tool-use-execute-bash.json'));

    expect(input.toolName).toBe('Bash');
    expect(input.toolInput).toEqual({ command: 'npm test -- --filter auth' });
  });

  it('passes MCP tool names (@server/tool) through unmapped', () => {
    const input = kiroAdapter.normalizeInput(loadFixture('post-tool-use-mcp.json'));

    expect(input.toolName).toBe('@git/git_status');
  });

  it('does not alias file_path when the tool is not a file built-in', () => {
    const input = kiroAdapter.normalizeInput({
      cwd: '/tmp',
      session_id: 's1',
      tool_name: 'use_aws',
      tool_input: { path: 's3://bucket/key' },
    });

    expect(input.toolName).toBe('use_aws');
    expect((input.toolInput as Record<string, unknown>).file_path).toBeUndefined();
  });

  it('never overwrites an existing file_path field', () => {
    const input = kiroAdapter.normalizeInput({
      cwd: '/tmp',
      session_id: 's1',
      tool_name: 'fs_write',
      tool_input: { path: '/a', file_path: '/b' },
    });

    expect((input.toolInput as Record<string, unknown>).file_path).toBe('/b');
  });

  it('maps stop assistant_response → lastAssistantMessage', () => {
    const input = kiroAdapter.normalizeInput(loadFixture('stop.json'));

    expect(input.lastAssistantMessage).toContain('fixed the login timeout bug');
    expect(input.transcriptPath).toBeUndefined();
  });

  it('rejects an invalid cwd', () => {
    expect(() => kiroAdapter.normalizeInput({ cwd: '', session_id: 's1' })).toThrow(AdapterRejectedInput);
  });

  it('falls back to process.cwd() when cwd is absent', () => {
    const input = kiroAdapter.normalizeInput({ session_id: 's1' });

    expect(input.cwd).toBe(process.cwd());
  });

  it('leaves sessionId undefined when both payload and env are absent (handlers skip)', () => {
    delete process.env.KIRO_SESSION_ID;
    const input = kiroAdapter.normalizeInput({ cwd: '/tmp', tool_name: 'fs_write', tool_input: { path: '/a' } });

    expect(input.sessionId).toBeUndefined();
  });

  it('passes non-object tool_input through untouched', () => {
    expect(kiroAdapter.normalizeInput({ cwd: '/tmp', session_id: 's1', tool_name: 'fs_write', tool_input: 'raw text' }).toolInput).toBe('raw text');
    expect(kiroAdapter.normalizeInput({ cwd: '/tmp', session_id: 's1', tool_name: 'fs_read', tool_input: null }).toolInput).toBeNull();
    expect(kiroAdapter.normalizeInput({ cwd: '/tmp', session_id: 's1', tool_name: 'fs_read', tool_input: ['a'] }).toolInput).toEqual(['a']);
  });
});

describe('kiroAdapter.formatOutput — raw-text contract', () => {
  it('returns additionalContext verbatim as a raw string', () => {
    const output = kiroAdapter.formatOutput({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '# Recent Activity\n- item' },
    });

    expect(output).toBe('# Recent Activity\n- item');
  });

  it('returns an empty string when there is no context (no stdout on Kiro)', () => {
    expect(kiroAdapter.formatOutput({ continue: true, suppressOutput: true })).toBe('');
    expect(kiroAdapter.formatOutput({} as never)).toBe('');
  });

  it('returns an empty string for whitespace-only context', () => {
    const output = kiroAdapter.formatOutput({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '   \n ' },
    });

    expect(output).toBe('');
  });

  it('drops systemMessage — Kiro has no user-visible hook channel', () => {
    const output = kiroAdapter.formatOutput({ systemMessage: 'viewer at http://localhost:37701' });

    expect(output).toBe('');
  });

  it('never emits JSON that Kiro stop could parse as a {"decision":"block"} override', () => {
    // A summarize-handler success result must serialize to NOTHING on Kiro:
    // any stdout on `stop` is parsed for a block-override that would force the
    // conversation to keep going.
    const output = kiroAdapter.formatOutput({
      continue: true,
      suppressOutput: true,
      exitCode: 0,
    });

    expect(output).toBe('');
  });
});
