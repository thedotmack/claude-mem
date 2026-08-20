import { describe, it, expect } from 'bun:test';
import {
  codexSpawn,
  resolveCodexCommand,
  resolveCodexSpawnInvocation,
} from '../../../src/services/integrations/CodexCliInstaller.js';
import { buildSpawnSyncInvocation } from '../../../src/shared/spawn.js';

// Windows spawn-contract fixes:
//   #2696 — removed with the chroma-mcp subprocess. There is no uvx invocation
//           left to get wrong: the vector index runs in-process.
//   #2696 — ChromaDB MCP subprocess: spawn uvx.exe DIRECTLY, never `cmd.exe /c uvx`.
//           cmd.exe parses the `>`/`<` in the dep-override specs (onnxruntime>=1.20,
//           protobuf<7) as shell redirection — even pre-quoted, Node's cmd.exe
//           arg-quoting re-mangles them — so cmd.exe dies with "The directory name
//           is invalid" and semantic search silently degrades to keyword-only.
//   #2695 — Codex CLI: spawnSync ENOENT for codex.cmd

describe('Windows #2695 - codex spawn resolves the .cmd shim without a shell', () => {
  it('shared spawn wrapper wraps .cmd shims with cmd.exe and windowsHide', () => {
    const invocation = buildSpawnSyncInvocation(
      'C:\\Tools\\bin\\tool.cmd',
      ['run', 'C:\\Path With Spaces'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      'win32',
    );

    expect(invocation.command).toBe('cmd.exe');
    expect(invocation.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""C:\\Tools\\bin\\tool.cmd" "run" "C:\\Path With Spaces""',
    ]);
    expect(invocation.options.windowsHide).toBe(true);
    expect(invocation.options.windowsVerbatimArguments).toBe(true);
    expect('shell' in invocation.options).toBe(false);
  });

  it('resolves a where-discovered codex.cmd path on Windows', () => {
    expect(resolveCodexCommand('win32', () => 'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd'))
      .toBe('C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd');
  });

  it('falls back to codex.cmd on Windows when lookup is unavailable', () => {
    expect(resolveCodexCommand('win32', () => null)).toBe('codex.cmd');
  });

  it('wraps .cmd shims with cmd.exe /d /s /c and one quoted command string without shell:true', () => {
    const invocation = resolveCodexSpawnInvocation(
      ['plugin', 'marketplace', 'add', 'C:\\Users\\tester\\Market Place'],
      'win32',
      () => 'C:\\Program Files\\nodejs\\codex.cmd',
    );

    expect(invocation.command).toBe('cmd.exe');
    expect(invocation.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""C:\\Program Files\\nodejs\\codex.cmd" "plugin" "marketplace" "add" "C:\\Users\\tester\\Market Place""',
    ]);
    expect(invocation.options.windowsHide).toBe(true);
    expect(invocation.options.windowsVerbatimArguments).toBe(true);
    expect('shell' in invocation.options).toBe(false);
  });

  it('wraps the codex.cmd fallback with cmd.exe /d /s /c without shell:true', () => {
    const invocation = resolveCodexSpawnInvocation(['--version'], 'win32', () => null);

    expect(invocation.command).toBe('cmd.exe');
    expect(invocation.args).toEqual(['/d', '/s', '/c', '""codex.cmd" "--version""']);
    expect(invocation.options.windowsVerbatimArguments).toBe(true);
    expect('shell' in invocation.options).toBe(false);
  });

  it('spawns .exe and .com commands directly on Windows', () => {
    const exeInvocation = resolveCodexSpawnInvocation(['--version'], 'win32', () => 'C:\\Tools\\codex.exe');
    const comInvocation = resolveCodexSpawnInvocation(['--version'], 'win32', () => 'C:\\Tools\\codex.com');

    expect(exeInvocation.command).toBe('C:\\Tools\\codex.exe');
    expect(exeInvocation.args).toEqual(['--version']);
    expect('shell' in exeInvocation.options).toBe(false);
    expect(comInvocation.command).toBe('C:\\Tools\\codex.com');
    expect(comInvocation.args).toEqual(['--version']);
    expect('shell' in comInvocation.options).toBe(false);
  });

  it('uses bare codex on non-Windows platforms', () => {
    expect(resolveCodexCommand('linux')).toBe('codex');
    expect(resolveCodexCommand('darwin')).toBe('codex');
  });

  it('codexSpawn is exported and invokable (no crash on a bogus codex)', () => {
    // We can't assume codex is installed in CI. The contract under test is that
    // codexSpawn returns a SpawnSyncReturns rather than throwing synchronously.
    // Running `--version` either succeeds (codex present) or returns an
    // error/non-zero (codex absent); both are acceptable.
    expect(typeof codexSpawn).toBe('function');
    const result = codexSpawn(['--version']);
    expect(result).toBeDefined();
    // status is a number when the binary ran; error is set when not found.
    expect(result.status !== undefined || result.error !== undefined).toBe(true);
  });
});
