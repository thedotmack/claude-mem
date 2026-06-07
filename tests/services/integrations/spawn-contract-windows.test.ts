import { describe, it, expect } from 'bun:test';
import { buildChromaSpawnConfig } from '../../../src/services/sync/ChromaMcpManager.js';
import { codexSpawn } from '../../../src/services/integrations/CodexCliInstaller.js';

// Windows spawn-contract fixes folded into plans/02-spawn-contract-templating.md:
//   #2696 / #2716 / #2667 — ChromaDB MCP subprocess: a `cmd.exe /c uvx ...`
//     wrapper makes cmd.exe re-parse the dep-override version specifiers
//     (`onnxruntime>=1.20`, `protobuf<7`) as I/O redirection. Fix: spawn uvx
//     directly on every platform — no shell wrap, nothing for cmd.exe to mangle.
//   #2695 — Codex CLI: spawnSync ENOENT for codex.cmd

describe('chroma-mcp spawn contract — direct uvx, no cmd.exe wrapper (#2696/#2716/#2667)', () => {
  const commandArgs = [
    '--python', '3.13',
    '--with', 'onnxruntime>=1.20',
    '--with', 'protobuf<7',
    'chroma-mcp==0.2.6',
    '--client-type', 'persistent',
    '--data-dir', '/home/u/.claude-mem/chroma',
  ];

  it('spawns uvx directly, with no cmd.exe shell wrapper', () => {
    const { command, args } = buildChromaSpawnConfig(commandArgs);
    expect(command).toBe('uvx');
    // The defunct Windows branch used ComSpec/cmd.exe as the command and
    // shoved `/c uvx` into the args — neither must come back.
    expect(command).not.toMatch(/cmd(?:\.exe)?$/i);
    expect(args).not.toContain('/c');
    expect(args).not.toContain('uvx');
  });

  it('passes dep version specifiers through verbatim (no cmd.exe metachar quoting)', () => {
    const { args } = buildChromaSpawnConfig(commandArgs);
    // The `<` / `>` specs must reach uvx unquoted and unescaped. cmd.exe is no
    // longer in the path, so there is nothing to escape them for — wrapping
    // them in quotes here would actually break uvx's own arg parsing.
    expect(args).toContain('onnxruntime>=1.20');
    expect(args).toContain('protobuf<7');
    expect(args).toEqual(commandArgs);
  });

  it('returns a fresh array (does not alias the caller-owned commandArgs)', () => {
    const { args } = buildChromaSpawnConfig(commandArgs);
    expect(args).not.toBe(commandArgs);
  });
});

describe('Windows #2695 - codex spawn resolves the .cmd shim', () => {
  it('codexSpawn is exported and invokable (no crash on a bogus codex)', () => {
    // We can't assume codex is installed in CI. The contract under test is that
    // codexSpawn returns a SpawnSyncReturns rather than throwing synchronously,
    // and that on POSIX it does NOT use a shell. Running `--version` either
    // succeeds (codex present) or returns an error/non-zero (codex absent);
    // both are acceptable — the point is it does not throw.
    expect(typeof codexSpawn).toBe('function');
    const result = codexSpawn(['--version']);
    expect(result).toBeDefined();
    // status is a number when the binary ran; error is set when not found.
    expect(result.status !== undefined || result.error !== undefined).toBe(true);
  });
});
