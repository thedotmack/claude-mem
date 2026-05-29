import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, existsSync, rmSync } from 'fs';
import {
  buildHardenedSdkOptions,
  OBSERVER_DISALLOWED_TOOLS,
} from '../../src/sdk/hardened-options.js';
import {
  recordObserverToolAttempt,
  getObserverAuditLogPath,
} from '../../src/utils/observer-audit.js';
import { OBSERVER_SESSIONS_DIR } from '../../src/shared/paths.js';

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
    it('sets tools to an empty array (disables ALL built-in tools)', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      expect(Array.isArray(opts.tools)).toBe(true);
      expect(opts.tools).toHaveLength(0);
    });

    it('sets allowedTools to an empty array (nothing auto-approved)', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      expect(Array.isArray(opts.allowedTools)).toBe(true);
      expect(opts.allowedTools).toHaveLength(0);
    });

    it('keeps the full disallowedTools deny-list (12 tools)', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      const denied = opts.disallowedTools ?? [];
      for (const tool of OBSERVER_DISALLOWED_TOOLS) {
        expect(denied).toContain(tool);
      }
      expect(denied).toHaveLength(OBSERVER_DISALLOWED_TOOLS.length);
      expect(OBSERVER_DISALLOWED_TOOLS).toHaveLength(12);
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
