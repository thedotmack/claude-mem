import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import {
  buildMCodeHooks,
  checkMCodeStatus,
  installMCode,
  isClaudeMemMCodeHook,
  mcodeDataDir,
  uninstallMCode,
} from '../../src/services/integrations/MCodeHooksInstaller.js';

let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

// Every test writes under a temp dir; the real ~/.minimax is never touched.
function scratchDataDir(): string {
  scratch = path.join(tmpdir(), `mcode-install-test-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratch, '.minimax');
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

const read = (file: string) => JSON.parse(readFileSync(file, 'utf-8'));
const write = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2));
const quiet = () => {
  spyOn(console, 'log').mockImplementation(() => {});
  spyOn(console, 'warn').mockImplementation(() => {});
  return spyOn(console, 'error').mockImplementation(() => {});
};

const BUN = '/usr/local/bin/bun';
const WORKER = '/plugin/scripts/worker-service.cjs';
const USER_HOOK = { matcher: 'bash', hooks: [{ type: 'command', command: '/usr/bin/audit --log', timeout: 5 }] };

describe('mcodeDataDir', () => {
  test('is MINIMAX_DATA_DIR, else ~/.minimax', () => {
    expect(mcodeDataDir({ MINIMAX_DATA_DIR: '/data/minimax' })).toBe('/data/minimax');
    expect(mcodeDataDir({})).toBe(path.join(homedir(), '.minimax'));
  });
});

describe('buildMCodeHooks', () => {
  test('registers the handled events with a timeout MiniMax Code accepts', () => {
    const ours = buildMCodeHooks(BUN, WORKER);
    expect(Object.keys(ours)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);
    const hooks = Object.values(ours).flatMap((rules) => rules.map((rule) => rule.hooks[0]));
    expect(hooks.map((hook) => hook.command)).toEqual([
      `"${BUN}" "${WORKER}" start`,
      `"${BUN}" "${WORKER}" hook mcode context`,
      `"${BUN}" "${WORKER}" hook mcode session-init`,
      `"${BUN}" "${WORKER}" hook mcode observation`,
      `"${BUN}" "${WORKER}" hook mcode summarize`,
    ]);
    // Larger timeouts make MiniMax Code skip the hook.
    for (const hook of hooks) expect(hook.timeout).toBe(10);
    for (const hook of hooks) expect(isClaudeMemMCodeHook(hook)).toBe(true);
    expect(isClaudeMemMCodeHook(USER_HOOK.hooks[0])).toBe(false);
  });
});

describe('installMCode / uninstallMCode', () => {
  test('creates hooks.json (enabled) and mcp.json', () => {
    quiet();
    const dataDir = scratchDataDir();
    expect(installMCode(dataDir)).toBe(0);
    const hooks = read(path.join(dataDir, 'hooks.json'));
    expect(hooks.enabled).toBe(true);
    expect(Object.keys(hooks.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);
    const mcp = read(path.join(dataDir, 'mcp.json'));
    expect(String(mcp.mcpServers['claude-mem'].args[0])).toEndWith('mcp-server.cjs');
    expect(checkMCodeStatus(dataDir)).toBe(0);
  });

  test('keeps user hooks, servers and enabled: false; is idempotent; uninstall removes only ours', () => {
    quiet();
    const dataDir = scratchDataDir();
    const hooksFile = path.join(dataDir, 'hooks.json');
    const mcpFile = path.join(dataDir, 'mcp.json');
    write(hooksFile, { enabled: false, hooks: { PostToolUse: [USER_HOOK] } });
    write(mcpFile, { mcpServers: { other: { command: 'x', args: [] } } });

    expect(installMCode(dataDir)).toBe(0);
    expect(installMCode(dataDir)).toBe(0);
    const hooks = read(hooksFile);
    expect(hooks.enabled).toBe(false);
    expect(hooks.hooks.PostToolUse).toHaveLength(2);
    expect(hooks.hooks.PostToolUse[0]).toEqual(USER_HOOK);
    expect(hooks.hooks.SessionStart).toHaveLength(2);
    expect(Object.keys(read(mcpFile).mcpServers)).toEqual(['other', 'claude-mem']);
    expect(checkMCodeStatus(dataDir)).toBe(1);
    expect(readdirSync(dataDir).filter((name) => name.startsWith('hooks.json.bak-'))).toHaveLength(1);

    expect(uninstallMCode(dataDir)).toBe(0);
    expect(read(hooksFile)).toEqual({ enabled: false, hooks: { PostToolUse: [USER_HOOK] } });
    expect(read(mcpFile)).toEqual({ mcpServers: { other: { command: 'x', args: [] } } });
    expect(checkMCodeStatus(dataDir)).toBe(1);
  });

  test('refuses a hooks.json that is not a JSON object and leaves it unchanged', () => {
    const error = quiet();
    const dataDir = scratchDataDir();
    const hooksFile = path.join(dataDir, 'hooks.json');
    writeFileSync(hooksFile, '[]');
    expect(installMCode(dataDir)).toBe(1);
    expect(readFileSync(hooksFile, 'utf-8')).toBe('[]');
    expect(String(error.mock.calls[0]?.[0])).toContain('refusing to overwrite');
  });
});
