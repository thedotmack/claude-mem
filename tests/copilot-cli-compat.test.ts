import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { copilotAdapter } from '../src/cli/adapters/copilot.js';
import { AdapterRejectedInput } from '../src/cli/adapters/errors.js';
import {
  _buildCopilotCliHooksFile,
  copilotHooksFile,
  copilotHooksDir,
  copilotMcpConfigFile,
} from '../src/services/integrations/CopilotCliHooksInstaller.js';
import { COPILOT_HOOK_TIMEOUT_MS } from '../src/shared/host-hook-limits.js';

const INSTALLER_PATH = 'src/services/integrations/CopilotCliHooksInstaller.ts';

describe('CopilotCliHooksInstaller - event mapping and paths', () => {
  const src = readFileSync(INSTALLER_PATH, 'utf-8');

  it('maps sessionStart to context using COPILOT_HOOK_TIMEOUT_MS', () => {
    expect(src).toContain("sessionStart: [hook('context', sessionStartTimeoutSec)]");
  });

  it('maps userPromptSubmitted to session-init', () => {
    expect(src).toContain("userPromptSubmitted: [hook('session-init'");
  });

  it('maps postToolUse and postToolUseFailure to observation', () => {
    expect(src).toContain("postToolUse: [hook('observation'");
    expect(src).toContain("postToolUseFailure: [hook('observation'");
  });

  it('maps sessionEnd to summarize', () => {
    expect(src).toContain("sessionEnd: [hook('summarize'");
  });

  it('uses the copilot hook command string', () => {
    expect(src).toContain("hook', 'copilot'");
    expect(src).toContain('hook copilot');
  });

  it('resolves hooks and MCP paths at call time via COPILOT_HOME or ~/.copilot', () => {
    const defaultHooksFile = copilotHooksFile();
    expect(defaultHooksFile).toEndWith('.copilot/hooks/claude-mem.json');
    const defaultMcpConfig = copilotMcpConfigFile();
    expect(defaultMcpConfig).toEndWith('.copilot/mcp-config.json');

    const origCopilotHome = process.env.COPILOT_HOME;
    try {
      process.env.COPILOT_HOME = '/custom/copilot-home';
      expect(copilotHooksDir()).toBe('/custom/copilot-home/hooks');
      expect(copilotHooksFile()).toBe('/custom/copilot-home/hooks/claude-mem.json');
      expect(copilotMcpConfigFile()).toBe('/custom/copilot-home/mcp-config.json');
    } finally {
      if (origCopilotHome !== undefined) {
        process.env.COPILOT_HOME = origCopilotHome;
      } else {
        delete process.env.COPILOT_HOME;
      }
    }
  });

  it('reuses writeMcpJsonConfig from McpIntegrations.ts', () => {
    expect(src).toContain("from './McpIntegrations.js'");
    expect(src).toContain('writeMcpJsonConfig');
  });

  it('is wired into npx uninstall IDE cleanup', () => {
    const uninstallSrc = readFileSync('src/npx-cli/commands/uninstall.ts', 'utf-8');
    expect(uninstallSrc).toContain('uninstallCopilotCliHooks');
  });

  it('bakes exec+args (no shell) with the copilot hook marker env and registered sessionStart timeout', () => {
    const file = _buildCopilotCliHooksFile('/usr/bin/bun', '/tmp/worker-service.cjs');
    expect(file.version).toBe(1);
    const sessionStart = file.hooks.sessionStart[0];
    expect(sessionStart.exec).toBe('/usr/bin/bun');
    expect(sessionStart.args).toEqual(['/tmp/worker-service.cjs', 'hook', 'copilot', 'context']);
    expect(sessionStart.timeoutSec).toBe(COPILOT_HOOK_TIMEOUT_MS / 1000);
    expect(sessionStart.env?.CLAUDE_MEM_COPILOT_HOOK).toBe('1');
    expect(typeof sessionStart.cwd).toBe('string');
  });

  it('round-trips Windows-style backslash paths through the JSON hooks file unchanged', () => {
    const winExec = 'C:\\Users\\tester\\.bun\\bin\\bun.exe';
    const winWorkerPath = 'C:\\Users\\tester\\.claude\\plugins\\marketplaces\\thedotmack\\plugin\\scripts\\worker-service.cjs';
    const file = _buildCopilotCliHooksFile(winExec, winWorkerPath);

    const roundTripped = JSON.parse(JSON.stringify(file, null, 2)) as typeof file;
    const sessionStart = roundTripped.hooks.sessionStart[0];
    expect(sessionStart.exec).toBe(winExec);
    expect(sessionStart.args[0]).toBe(winWorkerPath);

    const postToolUse = roundTripped.hooks.postToolUse[0];
    expect(postToolUse.exec).toBe(winExec);
    expect(postToolUse.args).toEqual([winWorkerPath, 'hook', 'copilot', 'observation']);
  });
});

describe('copilotAdapter - normalizeInput and formatOutput', () => {
  it('throws AdapterRejectedInput(missing_session_id) when sessionId is missing', () => {
    expect(() => copilotAdapter.normalizeInput({ cwd: '/tmp/test' })).toThrow(
      new AdapterRejectedInput('missing_session_id')
    );
    expect(() => copilotAdapter.normalizeInput({})).toThrow(
      new AdapterRejectedInput('missing_session_id')
    );
  });

  it('falls back to process.cwd() when no cwd is provided but sessionId is present', () => {
    const result = copilotAdapter.normalizeInput({ sessionId: 's1' });
    expect(result.cwd).toBe(process.cwd());
    expect(result.sessionId).toBe('s1');
  });

  it('accepts camelCase Copilot CLI fields', () => {
    const result = copilotAdapter.normalizeInput({
      cwd: '/tmp/explicit-cwd',
      sessionId: 'sess-1',
      prompt: 'hello',
      toolName: 'bash',
      toolInput: { command: 'ls' },
      toolOutput: 'ok',
    });
    expect(result.cwd).toBe('/tmp/explicit-cwd');
    expect(result.sessionId).toBe('sess-1');
    expect(result.prompt).toBe('hello');
    expect(result.toolName).toBe('bash');
    expect(result.toolResponse).toBe('ok');
  });

  it('accepts snake_case aliases', () => {
    const result = copilotAdapter.normalizeInput({
      cwd: '/tmp/snake',
      session_id: 'sess-2',
      user_prompt: 'hi',
      tool_name: 'view',
      tool_output: 'file contents',
    });
    expect(result.sessionId).toBe('sess-2');
    expect(result.prompt).toBe('hi');
    expect(result.toolName).toBe('view');
    expect(result.toolResponse).toBe('file contents');
  });

  it('unwraps Copilot CLI toolResult.textResultForLlm', () => {
    const result = copilotAdapter.normalizeInput({
      cwd: '/tmp/explicit-cwd',
      sessionId: 'sess-3',
      toolName: 'bash',
      toolArgs: { command: 'ls' },
      toolResult: { resultType: 'success', textResultForLlm: 'README.md' },
    });
    expect(result.toolName).toBe('bash');
    expect(result.toolInput).toEqual({ command: 'ls' });
    expect(result.toolResponse).toBe('README.md');
  });

  it('is registered as copilot and copilot-cli', () => {
    const indexSrc = readFileSync('src/cli/adapters/index.ts', 'utf-8');
    expect(indexSrc).toContain("case 'copilot': case 'copilot-cli': return copilotAdapter");
  });

  it('formatOutput emits only documented keys (additionalContext)', () => {
    const withContext = copilotAdapter.formatOutput({
      continue: true,
      hookSpecificOutput: { additionalContext: 'past work' },
    });
    expect(withContext).toEqual({
      additionalContext: 'past work',
    });
    expect(Object.keys(withContext)).toEqual(['additionalContext']);

    const empty = copilotAdapter.formatOutput({
      continue: true,
    });
    expect(empty).toEqual({});
    expect(Object.keys(empty)).toEqual([]);
  });
});

describe('copilot contract fixture (tests/fixtures/hosts/copilot-cli-hooks.json)', () => {
  const fixturePath = 'tests/fixtures/hosts/copilot-cli-hooks.json';
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));

  it('normalizes sessionStart payload accurately', () => {
    const normalized = copilotAdapter.normalizeInput(fixture.payloads.sessionStart);
    expect(normalized.sessionId).toBe('copilot-session-123');
    expect(normalized.cwd).toBe('/work/project');
    expect(normalized.prompt).toBe('fix the authentication bug');
  });

  it('normalizes userPromptSubmitted payload accurately', () => {
    const normalized = copilotAdapter.normalizeInput(fixture.payloads.userPromptSubmitted);
    expect(normalized.sessionId).toBe('copilot-session-123');
    expect(normalized.cwd).toBe('/work/project');
    expect(normalized.prompt).toBe('run tests');
  });

  it('normalizes postToolUse payload with textResultForLlm unwrap', () => {
    const normalized = copilotAdapter.normalizeInput(fixture.payloads.postToolUse);
    expect(normalized.sessionId).toBe('copilot-session-123');
    expect(normalized.toolName).toBe('bash');
    expect(normalized.toolInput).toEqual({ command: 'npm test' });
    expect(normalized.toolResponse).toBe('15 tests passed');
  });

  it('normalizes postToolUseFailure payload', () => {
    const normalized = copilotAdapter.normalizeInput(fixture.payloads.postToolUseFailure);
    expect(normalized.sessionId).toBe('copilot-session-123');
    expect(normalized.toolName).toBe('bash');
    expect(normalized.toolInput).toEqual({ command: 'npm test' });
    expect(normalized.toolResponse).toBe('Command failed with exit code 1');
  });

  it('ensures formatOutput emits only documented keys for all hook responses', () => {
    const output = copilotAdapter.formatOutput({
      continue: true,
      systemMessage: 'unsupported in copilot',
      hookSpecificOutput: { additionalContext: 'test-context' },
    });
    expect(output).toEqual({ additionalContext: 'test-context' });
    expect(Object.keys(output)).toEqual(['additionalContext']);
  });
});
