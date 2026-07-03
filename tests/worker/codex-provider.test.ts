import { describe, expect, it } from 'bun:test';
import { existsSync, rmSync, statSync } from 'fs';
import {
  buildCodexExecEnv,
  buildCodexExecArgs,
  buildCodexObservationPrompt,
  classifyCodexExecError,
  createCodexExecWorkDir,
  normalizeCodexExecutablePath,
  parseCodexReasoningEffort,
  parseCodexExecJsonl,
} from '../../src/services/worker/CodexProvider.js';

describe('parseCodexExecJsonl', () => {
  it('extracts the final assistant message and Codex usage from exec JSONL', () => {
    const result = parseCodexExecJsonl([
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item-1',
          type: 'agent_message',
          text: '<observation><type>discovery</type><title>Codex</title><narrative>Captured.</narrative></observation>',
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 3,
          reasoning_output_tokens: 1,
        },
      }),
    ].join('\n'));

    expect(result.content).toContain('<observation>');
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(4);
    expect(result.tokensUsed).toBe(16);
  });

  it('ignores non-JSON progress lines and uses the latest agent message', () => {
    const result = parseCodexExecJsonl([
      'Codex CLI starting...',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'second' } }),
    ].join('\n'));

    expect(result.content).toBe('second');
    expect(result.tokensUsed).toBeUndefined();
  });
});

describe('classifyCodexExecError', () => {
  it('classifies a missing Codex executable as unrecoverable', () => {
    const cause = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    const err = classifyCodexExecError({ cause });

    expect(err.kind).toBe('unrecoverable');
    expect(err.message).toContain('CLAUDE_MEM_CODEX_PATH');
    expect(err.cause).toBe(cause);
  });

  it('classifies login failures as auth_invalid', () => {
    const err = classifyCodexExecError({
      exitCode: 1,
      stderr: 'not logged in; run codex login',
      cause: new Error('codex failed'),
    });

    expect(err.kind).toBe('auth_invalid');
  });

  it('classifies plan usage caps as quota_exhausted', () => {
    const err = classifyCodexExecError({
      exitCode: 1,
      stderr: 'usage limit reached for this plan',
      cause: new Error('codex failed'),
    });

    expect(err.kind).toBe('quota_exhausted');
  });
});

describe('parseCodexReasoningEffort', () => {
  it('accepts supported Codex reasoning effort values', () => {
    expect(parseCodexReasoningEffort('low')).toBe('low');
    expect(parseCodexReasoningEffort(' HIGH ')).toBe('high');
    expect(parseCodexReasoningEffort('minimal')).toBe('minimal');
  });

  it('ignores empty or unsupported values', () => {
    expect(parseCodexReasoningEffort('')).toBeNull();
    expect(parseCodexReasoningEffort('fast')).toBeNull();
  });
});

describe('buildCodexExecArgs', () => {
  it('runs Codex exec as an isolated read-only non-interactive turn', () => {
    const workDir = '/tmp/claude-mem-codex-test';
    const args = buildCodexExecArgs({
      model: 'gpt-5.4-mini',
      reasoningEffort: null,
    }, workDir);

    expect(args).toContain('--json');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('--cd');
    expect(args[args.indexOf('--cd') + 1]).toBe(workDir);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--dangerously-bypass-hook-trust');
  });

  it('passes reasoning effort through a Codex config override', () => {
    const args = buildCodexExecArgs({
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
    }, '/tmp/claude-mem-codex-test');

    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort="low"');
  });

  it('omits the reasoning override when unset', () => {
    const args = buildCodexExecArgs({
      model: 'gpt-5.4-mini',
      reasoningEffort: null,
    }, '/tmp/claude-mem-codex-test');

    expect(args).not.toContain('-c');
    expect(args.some(arg => arg.startsWith('model_reasoning_effort='))).toBe(false);
  });
});

describe('createCodexExecWorkDir', () => {
  it('creates a private temporary workdir for each codex exec attempt', () => {
    const workDir = createCodexExecWorkDir();
    try {
      expect(existsSync(workDir)).toBe(true);
      if (process.platform !== 'win32') {
        expect(statSync(workDir).mode & 0o777).toBe(0o700);
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('normalizeCodexExecutablePath', () => {
  it('defaults blank values to codex', () => {
    expect(normalizeCodexExecutablePath(undefined)).toBe('codex');
    expect(normalizeCodexExecutablePath('   ')).toBe('codex');
  });

  it('rejects Windows shell metacharacters in custom codex paths', () => {
    expect(() => normalizeCodexExecutablePath('codex & calc.exe', 'win32')).toThrow(/unsafe/);
    expect(() => normalizeCodexExecutablePath('codex%COMSPEC%', 'win32')).toThrow(/unsafe/);
    expect(() => normalizeCodexExecutablePath('"C:\\Program Files\\Codex\\codex.cmd"', 'win32')).toThrow(/unsafe/);
  });

  it('allows ordinary Windows executable paths', () => {
    expect(normalizeCodexExecutablePath('C:\\Program Files\\Codex\\codex.cmd', 'win32'))
      .toBe('C:\\Program Files\\Codex\\codex.cmd');
  });
});

describe('buildCodexExecEnv', () => {
  it('keeps only OS basics and Codex-specific paths for the subprocess', () => {
    const env = buildCodexExecEnv({
      PATH: '/usr/bin',
      HOME: '/home/tester',
      CODEX_HOME: '/home/tester/.codex',
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/local-ca.pem',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      GEMINI_API_KEY: 'gemini-secret',
      OPENROUTER_API_KEY: 'openrouter-secret',
      OPENAI_API_KEY: 'openai-secret',
      HTTPS_PROXY: 'http://proxy.local:8080',
      HTTP_PROXY: 'http://proxy.local:8080',
      NO_PROXY: 'localhost,127.0.0.1',
      CUSTOM_TOKEN: 'custom-secret',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/tester');
    expect(env.CODEX_HOME).toBe('/home/tester/.codex');
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/local-ca.pem');

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    // Proxy variables are intentionally not inherited; Codex runs with an
    // explicit, minimal environment rather than ambient network routing state.
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.CUSTOM_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });
});

describe('buildCodexObservationPrompt', () => {
  it('adds anti-fragmentation rules for Codex observation generation', () => {
    const prompt = buildCodexObservationPrompt({
      id: 1,
      tool_name: 'Bash',
      tool_input: JSON.stringify({ cmd: 'git diff --stat' }),
      tool_output: JSON.stringify({ output: 'file.ts | 137 ++++++++++++++++-----------' }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('at most 3 <observation>...</observation> blocks');
    expect(prompt).toContain('Prefer one observation per tool use');
    expect(prompt).toContain('Every emitted observation must include a non-empty <narrative>');
    expect(prompt).toContain('Do not split a single command output');
  });
});
