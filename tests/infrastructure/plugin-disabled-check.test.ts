import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isPluginDisabledInClaudeSettings } from '../../src/shared/plugin-state.js';

let tempDir: string;
let originalClaudeConfigDir: string | undefined;
let originalQoderHookMarker: string | undefined;

beforeEach(() => {
  tempDir = join(tmpdir(), `plugin-disabled-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tempDir;
  originalQoderHookMarker = process.env.CLAUDE_MEM_QODER_HOOK;
  delete process.env.CLAUDE_MEM_QODER_HOOK;
});

afterEach(() => {
  if (originalQoderHookMarker !== undefined) process.env.CLAUDE_MEM_QODER_HOOK = originalQoderHookMarker;
  else delete process.env.CLAUDE_MEM_QODER_HOOK;
  if (originalClaudeConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  } else {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('isPluginDisabledInClaudeSettings (#781)', () => {
  it.each([
    ['missing settings', undefined, false],
    ['enabled plugin', JSON.stringify({ enabledPlugins: { 'claude-mem@thedotmack': true } }), false],
    ['disabled plugin', JSON.stringify({ enabledPlugins: { 'claude-mem@thedotmack': false } }), true],
    ['missing enabledPlugins', JSON.stringify({ permissions: { allow: [] } }), false],
    ['absent plugin', JSON.stringify({ enabledPlugins: { 'other-plugin@marketplace': true } }), false],
    ['invalid JSON', '{ invalid json }}}', false],
    ['empty settings', '', false],
  ] as const)('%s', (_name, contents, expected) => {
    if (contents !== undefined) writeFileSync(join(tempDir, 'settings.json'), contents);
    expect(isPluginDisabledInClaudeSettings()).toBe(expected);
  });

  it('ignores the Claude Code toggle for a Qoder hook', () => {
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'claude-mem@thedotmack': false } }));
    process.env.CLAUDE_MEM_QODER_HOOK = '1';
    expect(isPluginDisabledInClaudeSettings()).toBe(false);
  });
});
