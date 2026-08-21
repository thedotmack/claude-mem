import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  buildKimiHooksBlock,
  checkKimiHooksStatus,
  configureKimiMcp,
  installKimiHooks,
  KIMI_MARKER_BEGIN,
  KIMI_MARKER_END,
  removeManagedBlock,
  uninstallKimiHooks,
  upsertManagedBlock,
} from '../../src/services/integrations/KimiHooksInstaller.js';

const ORIGINAL_HOME = process.env.KIMI_CODE_HOME;
let scratch: string | undefined;

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.KIMI_CODE_HOME;
  else process.env.KIMI_CODE_HOME = ORIGINAL_HOME;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function makeScratchHome(): string {
  scratch = path.join(tmpdir(), `kimi-install-test-${process.pid}-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });
  process.env.KIMI_CODE_HOME = scratch;
  return scratch;
}

describe('managed block merge', () => {
  const block = `${KIMI_MARKER_BEGIN}\n[[hooks]]\nevent = "Stop"\ncommand = 'x'\n${KIMI_MARKER_END}`;

  test('appends to empty config', () => {
    expect(upsertManagedBlock('', block)).toBe(`${block}\n`);
  });

  test('replaces an existing managed block, preserving user content', () => {
    const user = 'default_model = "kimi-code/k3"\n';
    const once = upsertManagedBlock(user, block);
    const twice = upsertManagedBlock(once, block.replace('"Stop"', '"PreCompact"'));
    expect(twice).toContain('default_model');
    expect(twice).toContain('"PreCompact"');
    expect(twice).not.toContain('"Stop"');
    expect(twice.split(KIMI_MARKER_BEGIN)).toHaveLength(2);
  });

  test('removeManagedBlock strips exactly the block', () => {
    const merged = upsertManagedBlock('default_model = "kimi-code/k3"\n', block);
    const restored = removeManagedBlock(merged);
    expect(restored).not.toContain(KIMI_MARKER_BEGIN);
    expect(restored).toContain('default_model');
  });

  test('removeManagedBlock only collapses blank lines at the seam', () => {
    const user = 'a = 1\n\n\n\nb = 2\n';
    const merged = upsertManagedBlock(user, block);
    const restored = removeManagedBlock(merged);
    expect(restored).not.toContain(KIMI_MARKER_BEGIN);
    // Unrelated triple blank lines in user content must stay untouched.
    expect(restored).toContain('a = 1\n\n\n\nb = 2');
    // The seam at the end should leave exactly one terminating newline.
    expect(restored).toMatch(/b = 2\n$/);
  });

  test('removeManagedBlock leaves at most one blank line at the join', () => {
    const merged = `a = 1\n\n\n${block}\n\n\nb = 2\n`;
    const restored = removeManagedBlock(merged);
    expect(restored).not.toContain(KIMI_MARKER_BEGIN);
    expect(restored).toBe('a = 1\n\nb = 2\n');
  });
});

describe('installKimiHooks', () => {
  test('writes the managed block, backs up config, is idempotent', () => {
    const home = makeScratchHome();
    writeFileSync(path.join(home, 'config.toml'), 'default_model = "kimi-code/k3"\n');
    expect(installKimiHooks()).toBe(0);
    const config = readFileSync(path.join(home, 'config.toml'), 'utf-8');
    expect(config).toContain(KIMI_MARKER_BEGIN);
    expect(config).toContain('hook kimi context');
    expect(config).toContain('hook kimi observation');
    expect(config).toContain('hook kimi summarize');
    expect(config).toContain('default_model'); // user content preserved
    // second run: no duplicate block
    expect(installKimiHooks()).toBe(0);
    const again = readFileSync(path.join(home, 'config.toml'), 'utf-8');
    expect(again.split(KIMI_MARKER_BEGIN)).toHaveLength(2);
  });

  test('status reports installed state; uninstall removes the block', () => {
    const home = makeScratchHome();
    expect(checkKimiHooksStatus()).toBe(1); // not installed
    expect(installKimiHooks()).toBe(0);
    expect(checkKimiHooksStatus()).toBe(0);
    expect(uninstallKimiHooks()).toBe(0);
    expect(checkKimiHooksStatus()).toBe(1);
    expect(readFileSync(path.join(home, 'config.toml'), 'utf-8')).not.toContain(KIMI_MARKER_BEGIN);
  });
});

describe('configureKimiMcp', () => {
  test('adds mcp-search without clobbering existing servers', () => {
    const home = makeScratchHome();
    writeFileSync(path.join(home, 'mcp.json'), JSON.stringify({ mcpServers: { context7: { url: 'https://mcp.context7.com/mcp' } } }, null, 2));
    expect(configureKimiMcp()).toBe(0);
    const mcp = JSON.parse(readFileSync(path.join(home, 'mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.context7).toBeDefined();
    expect(mcp.mcpServers['mcp-search'].type).toBe('stdio');
    expect(mcp.mcpServers['mcp-search'].args[0]).toContain('mcp-server.cjs');
    // idempotent
    expect(configureKimiMcp()).toBe(0);
  });
});

describe('buildKimiHooksBlock', () => {
  test('contains all six rules with TOML literal commands and valid timeouts', () => {
    const block = buildKimiHooksBlock('/home/u/.bun/bin/bun', '/x/worker-service.cjs');
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreToolUse', 'Stop', 'PreCompact']) {
      expect(block).toContain(`event = "${event}"`);
    }
    expect(block).toContain("command = '\"/home/u/.bun/bin/bun\" \"/x/worker-service.cjs\"");
    expect(block).toContain('matcher = "Read"');
    const timeouts = [...block.matchAll(/timeout = (\d+)/g)].map((m) => Number(m[1]));
    expect(timeouts).toHaveLength(6);
    for (const t of timeouts) {
      expect(t).toBeGreaterThanOrEqual(1);
      expect(t).toBeLessThanOrEqual(600);
    }

    // SessionStart only starts the worker; context injection happens on UserPromptSubmit.
    const sessionStartMatch = block.match(/event = "SessionStart"[\s\S]*?event = "UserPromptSubmit"/);
    expect(sessionStartMatch).toBeDefined();
    expect(sessionStartMatch![0]).toContain(" start'");
    expect(sessionStartMatch![0]).not.toContain('hook kimi context');

    const userPromptSubmitMatch = block.match(/event = "UserPromptSubmit"[\s\S]*?event = "PostToolUse"/);
    expect(userPromptSubmitMatch).toBeDefined();
    expect(userPromptSubmitMatch![0]).toContain('hook kimi session-init');
    expect(userPromptSubmitMatch![0]).toContain('hook kimi context');
  });
});
