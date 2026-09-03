import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { copilotAdapter } from '../src/cli/adapters/copilot.js';
import { _buildCopilotCliHooksFile } from '../src/services/integrations/CopilotCliHooksInstaller.js';

const INSTALLER_PATH = 'src/services/integrations/CopilotCliHooksInstaller.ts';

describe('CopilotCliHooksInstaller - event mapping', () => {
  const src = readFileSync(INSTALLER_PATH, 'utf-8');

  it('maps sessionStart to context', () => {
    expect(src).toContain("sessionStart: [hook('context'");
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

  it('writes ~/.copilot/hooks/claude-mem.json and dual-writes MCP config', () => {
    expect(src).toContain("join(homedir(), '.copilot', 'hooks')");
    expect(src).toContain("join(homedir(), '.copilot', 'mcp-config.json')");
    expect(src).toContain("join(homedir(), '.github', 'copilot', 'mcp.json')");
  });

  it('reuses writeMcpJsonConfig from McpIntegrations.ts', () => {
    expect(src).toContain("from './McpIntegrations.js'");
    expect(src).toContain('writeMcpJsonConfig');
  });

  it('is wired into npx uninstall IDE cleanup', () => {
    const uninstallSrc = readFileSync('src/npx-cli/commands/uninstall.ts', 'utf-8');
    expect(uninstallSrc).toContain('uninstallCopilotCliHooks');
  });

  it('bakes exec+args (no shell) with the copilot hook marker env', () => {
    const file = _buildCopilotCliHooksFile('/usr/bin/bun', '/tmp/worker-service.cjs');
    expect(file.version).toBe(1);
    const sessionStart = file.hooks.sessionStart[0];
    expect(sessionStart.exec).toBe('/usr/bin/bun');
    expect(sessionStart.args).toEqual(['/tmp/worker-service.cjs', 'hook', 'copilot', 'context']);
    expect(sessionStart.env?.CLAUDE_MEM_COPILOT_HOOK).toBe('1');
    expect(typeof sessionStart.cwd).toBe('string');
  });

  it('round-trips Windows-style backslash paths through the JSON hooks file unchanged', () => {
    // exec/args are baked absolute paths (Rule B, see file header) — on
    // Windows those come from homedir()/path.join() and contain backslashes.
    // JSON.stringify escapes them as \\, so this asserts the file installer
    // actually writes survives a real JSON.stringify -> JSON.parse round trip
    // rather than a hand-rolled string that could double-escape or truncate.
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

describe('copilotAdapter - normalizeInput', () => {
  it('falls back to process.cwd() when no cwd is provided', () => {
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

  it('formatOutput emits additionalContext without suppressOutput', () => {
    const output = copilotAdapter.formatOutput({
      continue: true,
      hookSpecificOutput: { additionalContext: 'past work' },
    });
    expect(output).toEqual({
      permissionDecision: 'continue',
      additionalContext: 'past work',
    });
    expect('suppressOutput' in (output as object)).toBe(false);
  });
});
