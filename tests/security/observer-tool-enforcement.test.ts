import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, existsSync, rmSync, mkdtempSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  buildHardenedSdkOptions,
  OBSERVER_DISALLOWED_TOOLS,
} from '../../src/sdk/hardened-options.js';
import {
  recordObserverToolAttempt,
  getObserverAuditLogPath,
} from '../../src/utils/observer-audit.js';
import { OBSERVER_SESSIONS_DIR } from '../../src/shared/paths.js';
import { createSdkSpawnFactory, normalizeSpawnSdkArgs } from '../../src/supervisor/process-registry.js';

const BASE_INPUT = {
  source: 'Observer' as const,
  model: 'claude-sonnet-4-6',
  env: {} as NodeJS.ProcessEnv,
  pathToClaudeCodeExecutable: '/usr/bin/claude',
};

const AUDIT_PATH = getObserverAuditLogPath();

function readAuditLines(): Array<Record<string, unknown>> {
  if (!existsSync(AUDIT_PATH)) return [];
  return readFileSync(AUDIT_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('Observer/KnowledgeAgent SDK tool enforcement (hardened-options)', () => {
  describe('belt + suspenders + braces: option surface', () => {
    it('sets tools to an empty array (disables ALL built-in tools on the SDK path)', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      expect(Array.isArray(opts.tools)).toBe(true);
      expect(opts.tools).toHaveLength(0);
    });

    it('sets allowedTools to an empty array (nothing auto-approved)', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      expect(Array.isArray(opts.allowedTools)).toBe(true);
      expect(opts.allowedTools).toHaveLength(0);
    });

    it('keeps the full disallowedTools deny-list (14 tools)', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      const denied = opts.disallowedTools ?? [];
      for (const tool of OBSERVER_DISALLOWED_TOOLS) {
        expect(denied).toContain(tool);
      }
      expect(denied).toHaveLength(OBSERVER_DISALLOWED_TOOLS.length);
      expect(OBSERVER_DISALLOWED_TOOLS).toHaveLength(14);
    });

    it('denies the peer-session tools that let a toolless Observer borrow authority', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      const denied = opts.disallowedTools ?? [];
      expect(denied).toContain('SendMessage');
      expect(denied).toContain('ListAgents');
    });

    it("uses the most restrictive non-interactive permissionMode ('dontAsk')", () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      expect(opts.permissionMode).toBe('dontAsk');
    });

    it('never uses bypassPermissions', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      expect(opts.permissionMode).not.toBe('bypassPermissions');
    });

    it('isolates settings, MCP, and extra directories', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      expect(opts.mcpServers).toEqual({});
      expect(opts.settingSources).toEqual([]);
      expect(opts.strictMcpConfig).toBe(true);
      expect(opts.additionalDirectories).toEqual([]);
    });

    it('jails cwd to OBSERVER_SESSIONS_DIR and never falls back to process.cwd()', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      expect(opts.cwd).toBe(OBSERVER_SESSIONS_DIR);
      expect(opts.cwd).not.toBe(process.cwd());
    });

    it('exposes a canUseTool callback', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      expect(typeof opts.canUseTool).toBe('function');
    });
  });

  describe('canUseTool denies every invocation and audit-logs it', () => {
    beforeEach(() => {
      rmSync(AUDIT_PATH, { force: true });
    });
    afterEach(() => {
      rmSync(AUDIT_PATH, { force: true });
    });

    const callCanUseTool = async (
      input: Parameters<typeof buildHardenedSdkOptions>[0],
      toolName: string,
      toolInput: Record<string, unknown>
    ) => {
      const opts = buildHardenedSdkOptions(input);
      const canUseTool = opts.canUseTool;
      if (!canUseTool) throw new Error('canUseTool missing');
      return canUseTool(toolName, toolInput, {
        signal: new AbortController().signal,
        toolUseID: 'test-tool-use-id',
      });
    };

    it('denies Write and records a denied audit entry', async () => {
      const result = await callCanUseTool(
        { ...BASE_INPUT, sessionDbId: 42, contentSessionId: 'cs-1', project: 'demo' },
        'Write',
        { file_path: '/tmp/CLAUDE_MEM_PWNED.txt', content: 'pwned' }
      );
      expect(result.behavior).toBe('deny');

      const lines = readAuditLines();
      expect(lines).toHaveLength(1);
      expect(lines[0].tool_name).toBe('Write');
      expect(lines[0].result).toBe('denied');
      expect(lines[0].source).toBe('Observer');
      expect(lines[0].sessionDbId).toBe(42);
      expect(lines[0].contentSessionId).toBe('cs-1');
      expect(lines[0].project).toBe('demo');
    });

    it('denies Bash, Edit, Read, and Task — all tool names denied', async () => {
      for (const tool of ['Bash', 'Edit', 'Read', 'Task', 'SomeFutureUnknownTool']) {
        const result = await callCanUseTool({ ...BASE_INPUT }, tool, { x: 1 });
        expect(result.behavior).toBe('deny');
        if (result.behavior === 'deny') {
          expect(typeof result.message).toBe('string');
          expect(result.message.length).toBeGreaterThan(0);
        }
      }
      const lines = readAuditLines();
      expect(lines).toHaveLength(5);
      expect(lines.every((l) => l.result === 'denied')).toBe(true);
    });

    it('truncates oversized tool_input in the audit log', async () => {
      const huge = 'A'.repeat(10_000);
      await callCanUseTool({ ...BASE_INPUT }, 'Write', { content: huge });
      const lines = readAuditLines();
      expect(lines).toHaveLength(1);
      const recorded = String(lines[0].tool_input);
      expect(recorded.length).toBeLessThan(huge.length);
      expect(recorded).toContain('[TRUNCATED]');
    });

    it('recordObserverToolAttempt is best-effort and never throws', () => {
      expect(() =>
        recordObserverToolAttempt({
          source: 'KnowledgeAgent',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /' },
          result: 'denied',
        })
      ).not.toThrow();
    });
  });

  describe('both call sites are configured identically via the shared helper', () => {
    // Stripping the call-site-specific fields (canUseTool closure identity,
    // resume, source-tagged audit identifiers) must leave IDENTICAL lockdown.
    const lockdownShape = (
      input: Parameters<typeof buildHardenedSdkOptions>[0]
    ) => {
      const o = buildHardenedSdkOptions(input);
      return {
        tools: o.tools,
        allowedTools: o.allowedTools,
        disallowedTools: o.disallowedTools,
        permissionMode: o.permissionMode,
        mcpServers: o.mcpServers,
        settingSources: o.settingSources,
        strictMcpConfig: o.strictMcpConfig,
        additionalDirectories: o.additionalDirectories,
        cwd: o.cwd,
        hasCanUseTool: typeof o.canUseTool === 'function',
      };
    };

    it('Observer and KnowledgeAgent produce the same lockdown shape', () => {
      const observer = lockdownShape({
        source: 'Observer',
        sessionDbId: 1,
        contentSessionId: 'obs',
        project: 'p',
        model: 'm',
        env: {},
        pathToClaudeCodeExecutable: '/c',
        abortController: new AbortController(),
        spawnClaudeCodeProcess: () => ({}) as never,
      });
      const knowledge = lockdownShape({
        source: 'KnowledgeAgent',
        project: 'corpus',
        model: 'm',
        env: {},
        pathToClaudeCodeExecutable: '/c',
        resume: 'session-xyz',
      });
      expect(observer).toEqual(knowledge);
    });
  });
});

/**
 * F1 — `tools: []` must reach the Claude CLI on the Observer spawn path.
 *
 * The SDK serializes `tools: []` as the argv pair `--tools ""`. The Observer
 * spawn factory used to drop every `--flag ""` pair (an old workaround for
 * cmd.exe losing empty arguments), so the CLI never saw `--tools` and ran with
 * its full default tool set; only the deny-list, `dontAsk` and `canUseTool`
 * were enforcing. The pair is now kept as the single token `--tools=`, which
 * the CLI reads exactly like `--tools ""` (no built-in tools) and which
 * survives cmd.exe.
 */
describe('F1: the empty tool list reaches the Claude CLI', () => {
  it('normalizeSpawnSdkArgs keeps an empty SDK value as a single --flag= token', () => {
    expect(normalizeSpawnSdkArgs(['--tools', '', '--disallowedTools', 'Bash,Read'])).toEqual([
      '--tools=',
      '--disallowedTools',
      'Bash,Read',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'the spawned Observer argv carries --tools= (SDK serialization -> spawn factory -> child argv)',
    async () => {
      const fakeCliDir = mkdtempSync(join(tmpdir(), 'claude-mem-fake-cli-'));
      const argvOutPath = join(fakeCliDir, 'argv.txt');
      const fakeCliPath = join(fakeCliDir, 'claude');
      // A stand-in `claude` that records its argv, one token per line, and exits.
      writeFileSync(fakeCliPath, `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done > '${argvOutPath}'\n`);
      chmodSync(fakeCliPath, 0o755);
      const sessionDbId = 1_000_000 + process.pid;

      try {
        const observerQuery = query({
          prompt: 'observe',
          options: buildHardenedSdkOptions({
            ...BASE_INPUT,
            sessionDbId,
            env: { ...process.env },
            pathToClaudeCodeExecutable: fakeCliPath,
            spawnClaudeCodeProcess: createSdkSpawnFactory(sessionDbId),
          }),
        });
        try {
          for await (const _message of observerQuery) {
            // The fake CLI exits without speaking stream-json; the query ends or throws.
          }
        } catch {
          // Expected: the stand-in CLI is not a real Claude Code process.
        }

        // One token per line; drop only the final newline so an empty token stays visible.
        const spawnedArgv = readFileSync(argvOutPath, 'utf8').replace(/\n$/, '').split('\n');
        expect(spawnedArgv).toContain('--tools=');
        expect(spawnedArgv).not.toContain('--tools');
        expect(spawnedArgv).not.toContain('');
        // SDK releases use either --flag value or --flag=value. Verify the
        // actual safety controls, independently of that serialization choice.
        const flagValue = (flag: string): string | undefined => {
          const joined = spawnedArgv.find(arg => arg.startsWith(`${flag}=`));
          if (joined !== undefined) return joined.slice(flag.length + 1);
          const index = spawnedArgv.indexOf(flag);
          return index >= 0 ? spawnedArgv[index + 1] : undefined;
        };
        expect(flagValue('--disallowedTools')?.split(',')).toEqual([...OBSERVER_DISALLOWED_TOOLS]);
        expect(flagValue('--permission-mode')).toBe('dontAsk');
      } finally {
        rmSync(fakeCliDir, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
