import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  installKimiHooks,
  uninstallKimiHooks,
  mergeKimiHooksToml,
  removeKimiHooksToml,
  kimiConfigTomlPath,
  kimiMcpJsonPath,
} from '../../src/services/integrations/KimiHooksInstaller.js';

/**
 * Kimi Code installer tests. Every test points KIMI_CODE_HOME at a fresh temp
 * dir, so the real ~/.kimi-code is never read or written.
 */

const ORIGINAL_KIMI_HOME = process.env.KIMI_CODE_HOME;
let fakeHome: string;

beforeEach(() => {
  fakeHome = fs.mkdtempSync(join(tmpdir(), 'kimi-code-home-'));
  process.env.KIMI_CODE_HOME = fakeHome;
});

afterEach(() => {
  if (ORIGINAL_KIMI_HOME === undefined) {
    delete process.env.KIMI_CODE_HOME;
  } else {
    process.env.KIMI_CODE_HOME = ORIGINAL_KIMI_HOME;
  }
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

function readConfigToml(): string {
  return fs.readFileSync(join(fakeHome, 'config.toml'), 'utf-8');
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('KIMI_CODE_HOME override', () => {
  it('resolves config.toml and mcp.json under the override', () => {
    expect(kimiConfigTomlPath()).toBe(join(fakeHome, 'config.toml'));
    expect(kimiMcpJsonPath()).toBe(join(fakeHome, 'mcp.json'));
  });
});

describe('mergeKimiHooksToml / removeKimiHooksToml (pure merge)', () => {
  const block = [
    '# >>> claude-mem kimi hooks (managed — do not edit)',
    '[[hooks]]',
    'event = "SessionStart"',
    'command = "\\"bun\\" \\"/x/worker-service.cjs\\" hook kimi context"',
    '# <<< claude-mem kimi hooks',
  ].join('\n');

  it('appends the managed block to an empty config', () => {
    const merged = mergeKimiHooksToml('', block);
    expect(merged).toContain('[[hooks]]');
    expect(merged.endsWith('\n')).toBe(true);
  });

  it('preserves user config and user-owned hook entries', () => {
    const userConfig = [
      'theme = "dark"',
      '',
      '[[hooks]]',
      'event = "SessionEnd"',
      'command = "echo bye"',
      '',
    ].join('\n');

    const merged = mergeKimiHooksToml(userConfig, block);
    expect(merged).toContain('theme = "dark"');
    expect(merged).toContain('command = "echo bye"');
    expect(countOccurrences(merged, '[[hooks]]')).toBe(2);
  });

  it('replaces the managed block in place on re-install (idempotent)', () => {
    const first = mergeKimiHooksToml('theme = "dark"\n', block);
    const second = mergeKimiHooksToml(first, block);
    expect(second).toBe(first);
  });

  it('removes exactly the managed block on uninstall', () => {
    const userConfig = 'theme = "dark"\n\n[[hooks]]\nevent = "SessionEnd"\ncommand = "echo bye"\n';
    const merged = mergeKimiHooksToml(userConfig, block);
    const removed = removeKimiHooksToml(merged);

    expect(removed).not.toContain('claude-mem kimi hooks');
    expect(removed).toContain('theme = "dark"');
    expect(removed).toContain('command = "echo bye"');
    expect(countOccurrences(removed, '[[hooks]]')).toBe(1);
  });

  it('returns content unchanged when no managed block is present', () => {
    const content = 'theme = "dark"\n';
    expect(removeKimiHooksToml(content)).toBe(content);
  });
});

describe('installKimiHooks', () => {
  it('writes all five hook events with only the allowed TOML fields', async () => {
    const result = await installKimiHooks();
    expect(result).toBe(0);

    const content = readConfigToml();
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
      expect(content).toContain(`event = "${event}"`);
    }
    expect(content).toContain('matcher = "startup|resume"');
    expect(content).toContain('matcher = "Read"');
    for (const internal of ['context', 'session-init', 'file-context', 'observation', 'summarize']) {
      expect(content).toContain(`hook kimi ${internal}`);
    }
    expect(countOccurrences(content, '[[hooks]]')).toBe(5);
    // Kimi hooks run their own worker instance (per-port PID/registry), sharing
    // the same DB as the default worker — env is baked into every command.
    expect(countOccurrences(content, 'CLAUDE_MEM_WORKER_PORT=37791')).toBe(5);
    // Kimi rejects unknown [[hooks]] fields — our entries carry only these.
    const managedBlock = content.slice(content.indexOf('# >>> claude-mem'));
    const fieldNames = managedBlock
      .split('\n')
      .filter((line) => /^[a-z_]+ =/.test(line))
      .map((line) => line.split(' =')[0]);
    expect([...new Set(fieldNames)].sort()).toEqual(['command', 'event', 'matcher', 'timeout']);
  });

  it('registers the claude-mem MCP server in mcp.json', async () => {
    const result = await installKimiHooks();
    expect(result).toBe(0);

    const mcp = JSON.parse(fs.readFileSync(join(fakeHome, 'mcp.json'), 'utf-8'));
    expect(mcp.mcpServers['claude-mem']).toBeDefined();
    expect(mcp.mcpServers['claude-mem'].command).toBeTruthy();
    expect(Array.isArray(mcp.mcpServers['claude-mem'].args)).toBe(true);
    expect(mcp.mcpServers['claude-mem'].args[0]).toContain('mcp-server.cjs');
    // MCP server must reach the same dedicated worker instance as the hooks.
    expect(mcp.mcpServers['claude-mem'].env).toEqual({
      CLAUDE_MEM_WORKER_PORT: '37791',
      CLAUDE_MEM_CHROMA_ENABLED: 'false',
    });
  });

  it('is idempotent — a second install does not duplicate entries', async () => {
    expect(await installKimiHooks()).toBe(0);
    expect(await installKimiHooks()).toBe(0);

    const content = readConfigToml();
    expect(countOccurrences(content, '[[hooks]]')).toBe(5);
    expect(countOccurrences(content, 'claude-mem kimi hooks (managed')).toBe(1);
  });

  it('replaces orphaned kimi hook entries whose markers a TOML serializer ate', async () => {
    // Kimi CLI rewrites config.toml and drops comments — our markers vanish,
    // and a naive reinstall would append a second full set (observed live
    // 2026-07-29: every injection fired twice). The merge must recognise our
    // entries by the `hook kimi` command signature even without markers.
    const orphan = (env: string) =>
      `[[hooks]]\nevent = "UserPromptSubmit"\ncommand = "${env} \\"bun\\" \\"/old/path/worker-service.cjs\\" hook kimi session-init"\ntimeout = 60\n`;
    fs.writeFileSync(
      join(fakeHome, 'config.toml'),
      `theme = "dark"\n\n${orphan('CLAUDE_MEM_WORKER_PORT=37791')}\n${orphan('CLAUDE_MEM_WORKER_PORT=37791 CLAUDE_MEM_CHROMA_ENABLED=false')}`,
    );

    expect(await installKimiHooks()).toBe(0);

    const content = readConfigToml();
    expect(content).toContain('theme = "dark"');
    expect(countOccurrences(content, '[[hooks]]')).toBe(5);
    expect(countOccurrences(content, 'hook kimi session-init')).toBe(1);
    expect(content).not.toContain('/old/path/');
  });

  it('preserves pre-existing user hooks and config keys', async () => {
    fs.writeFileSync(
      join(fakeHome, 'config.toml'),
      'theme = "dark"\n\n[[hooks]]\nevent = "SessionEnd"\ncommand = "echo bye"\ntimeout = 5\n',
    );

    expect(await installKimiHooks()).toBe(0);

    const content = readConfigToml();
    expect(content).toContain('theme = "dark"');
    expect(content).toContain('command = "echo bye"');
    expect(countOccurrences(content, '[[hooks]]')).toBe(6);
  });

  it('preserves a pre-existing mcp.json with other servers', async () => {
    fs.writeFileSync(
      join(fakeHome, 'mcp.json'),
      JSON.stringify({ mcpServers: { 'other-server': { command: 'foo', args: [] } } }, null, 2),
    );

    expect(await installKimiHooks()).toBe(0);

    const mcp = JSON.parse(fs.readFileSync(join(fakeHome, 'mcp.json'), 'utf-8'));
    expect(mcp.mcpServers['other-server']).toEqual({ command: 'foo', args: [] });
    expect(mcp.mcpServers['claude-mem']).toBeDefined();
  });
});

describe('uninstallKimiHooks', () => {
  it('removes hooks and MCP entry but preserves user config', async () => {
    fs.writeFileSync(
      join(fakeHome, 'config.toml'),
      'theme = "dark"\n\n[[hooks]]\nevent = "SessionEnd"\ncommand = "echo bye"\ntimeout = 5\n',
    );
    fs.writeFileSync(
      join(fakeHome, 'mcp.json'),
      JSON.stringify({ mcpServers: { 'other-server': { command: 'foo', args: [] } } }, null, 2),
    );

    expect(await installKimiHooks()).toBe(0);
    expect(uninstallKimiHooks()).toBe(0);

    const content = readConfigToml();
    expect(content).not.toContain('claude-mem');
    expect(content).not.toContain('hook kimi');
    expect(content).toContain('theme = "dark"');
    expect(content).toContain('command = "echo bye"');
    expect(countOccurrences(content, '[[hooks]]')).toBe(1);

    const mcp = JSON.parse(fs.readFileSync(join(fakeHome, 'mcp.json'), 'utf-8'));
    expect(mcp.mcpServers['claude-mem']).toBeUndefined();
    expect(mcp.mcpServers['other-server']).toBeDefined();
  });

  it('is a no-op when nothing was installed', () => {
    expect(uninstallKimiHooks()).toBe(0);
    expect(fs.existsSync(join(fakeHome, 'config.toml'))).toBe(false);
  });

  it('is safe to run twice', async () => {
    expect(await installKimiHooks()).toBe(0);
    expect(uninstallKimiHooks()).toBe(0);
    expect(uninstallKimiHooks()).toBe(0);
  });
});
