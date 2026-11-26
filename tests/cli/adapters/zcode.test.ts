import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import { claudeCodeAdapter, getPlatformAdapter, zcodeAdapter } from '../../../src/cli/adapters/index.js';
import { AdapterRejectedInput } from '../../../src/cli/adapters/errors.js';

const ENV_KEYS = ['ZCODE_PROJECT_DIR', 'CLAUDE_PROJECT_DIR'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  // A test run inside Claude Code inherits CLAUDE_PROJECT_DIR, which would win over the payload cwd.
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

// Real ZCode Desktop 4.0.0 payloads, sanitized (tests/fixtures/hosts/zcode-hooks.json).
const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dir, '..', '..', 'fixtures', 'hosts', 'zcode-hooks.json'), 'utf-8'),
);
const payloads = fixture.payloads;
const SESSION_ID = 'sess_00000000-0000-4000-8000-000000000001';
const PROJECT = '/Users/example/projects/zcode-test-project';

describe('zcodeAdapter against real ZCode payloads', () => {
  test('is the adapter for the zcode platform', () => {
    expect(getPlatformAdapter('zcode')).toBe(zcodeAdapter);
  });

  test('maps SessionStart source startup and drops an unknown source', () => {
    const input = zcodeAdapter.normalizeInput(payloads.SessionStart);
    expect(input.sessionId).toBe(SESSION_ID);
    expect(input.cwd).toBe(PROJECT);
    expect(input.sessionSource).toBe('startup');
    expect(zcodeAdapter.normalizeInput({ ...payloads.SessionStart, source: 'other' }).sessionSource).toBeUndefined();
  });

  test('reads the prompt from UserPromptSubmit', () => {
    expect(zcodeAdapter.normalizeInput(payloads.UserPromptSubmit).prompt).toBe('Read notes.txt and tell me what it says.');
  });

  test.each(['Read', 'Edit', 'Bash'])('keeps the %s tool name, input, response and tool_use_id', (tool) => {
    const payload = payloads[`PostToolUse${tool}`];
    const input = zcodeAdapter.normalizeInput(payload);
    expect(input.toolName).toBe(tool);
    expect(input.toolInput).toEqual(payload.tool_input);
    expect(input.toolResponse).toEqual(payload.tool_response);
    expect(input.toolUseId).toBe(payload.tool_use_id);
  });

  test('records a PostToolUseFailure as an error response', () => {
    const payload = payloads.PostToolUseFailure;
    const input = zcodeAdapter.normalizeInput(payload);
    expect(input.toolName).toBe('Read');
    expect(input.toolResponse).toEqual({ is_error: true, error: payload.error, is_interrupt: false });
  });

  test('ignores the deleted transcript_path and keeps the Stop message', () => {
    const input = zcodeAdapter.normalizeInput(payloads.Stop);
    expect(payloads.Stop.transcript_path).toBeTruthy();
    expect(input.transcriptPath).toBeUndefined();
    expect(input.lastAssistantMessage).toBe(payloads.Stop.last_assistant_message);
  });

  test('leaves lastAssistantMessage undefined when the Stop message is empty', () => {
    const input = zcodeAdapter.normalizeInput({ ...payloads.Stop, last_assistant_message: '' });
    expect(input.lastAssistantMessage).toBeUndefined();
    expect(input.transcriptPath).toBeUndefined();
  });

  test('maps a camelCase-only payload, and snake_case wins when both are set', () => {
    const input = zcodeAdapter.normalizeInput({ sessionId: 'camel', toolName: 'Read', cwd: PROJECT });
    expect(input.sessionId).toBe('camel');
    expect(input.toolName).toBe('Read');
    expect(zcodeAdapter.normalizeInput({ ...payloads.PostToolUseRead, toolName: 'Other' }).toolName).toBe('Read');
  });
});

describe('zcodeAdapter cwd and session id', () => {
  const { cwd: _cwd, ...withoutCwd } = payloads.PostToolUseRead;

  test('takes cwd from ZCODE_PROJECT_DIR when the payload has none', () => {
    process.env.ZCODE_PROJECT_DIR = import.meta.dir;
    expect(zcodeAdapter.normalizeInput(withoutCwd).cwd).toBe(import.meta.dir);
  });

  test('falls back to process.cwd() without cwd or ZCODE_PROJECT_DIR', () => {
    expect(zcodeAdapter.normalizeInput(withoutCwd).cwd).toBe(process.cwd());
  });

  describe('with CLAUDE_PROJECT_DIR inherited from the shell that started ZCode', () => {
    const otherProject = '/Users/example/projects/some-claude-project';
    beforeEach(() => {
      process.env.CLAUDE_PROJECT_DIR = otherProject;
    });

    test('keeps the payload cwd', () => {
      process.env.ZCODE_PROJECT_DIR = import.meta.dir;
      expect(zcodeAdapter.normalizeInput(payloads.PostToolUseRead).cwd).toBe(PROJECT);
    });

    test('takes ZCODE_PROJECT_DIR when the payload has no cwd', () => {
      process.env.ZCODE_PROJECT_DIR = import.meta.dir;
      expect(zcodeAdapter.normalizeInput(withoutCwd).cwd).toBe(import.meta.dir);
    });

    test('falls back to process.cwd() without cwd or ZCODE_PROJECT_DIR', () => {
      expect(zcodeAdapter.normalizeInput(withoutCwd).cwd).toBe(process.cwd());
    });

    test.each([
      ['empty', ''],
      ['not a string', 42],
    ])('rejects an %s cwd instead of using CLAUDE_PROJECT_DIR', (_label, cwd) => {
      let caught: unknown;
      try {
        zcodeAdapter.normalizeInput({ ...payloads.PostToolUseRead, cwd });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AdapterRejectedInput);
      expect((caught as AdapterRejectedInput).reason).toBe('invalid_cwd');
    });
  });

  test.each([
    ['missing', (({ session_id: _s, sessionId: _c, ...rest }) => rest)(payloads.PostToolUseRead)],
    ['empty', { ...payloads.PostToolUseRead, session_id: '', sessionId: '' }],
  ])('rejects a %s session_id', (_label, payload) => {
    let caught: unknown;
    try {
      zcodeAdapter.normalizeInput(payload);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdapterRejectedInput);
    expect((caught as AdapterRejectedInput).reason).toBe('missing_session_id');
  });
});

describe('zcodeAdapter.formatOutput', () => {
  test('emits the Claude Code hookSpecificOutput envelope', () => {
    const result = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'memory' } };
    expect(zcodeAdapter.formatOutput(result)).toEqual({ hookSpecificOutput: result.hookSpecificOutput });
    expect(zcodeAdapter.formatOutput(result)).toEqual(claudeCodeAdapter.formatOutput(result));
    expect(zcodeAdapter.formatOutput({})).toEqual({});
  });
});
