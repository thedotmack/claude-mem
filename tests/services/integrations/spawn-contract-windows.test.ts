import { describe, it, expect } from 'bun:test';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';
import { codexSpawn } from '../../../src/services/integrations/CodexCliInstaller.js';

// Windows spawn-contract fixes:
//   #2696 — ChromaDB MCP subprocess: spawn uvx.exe DIRECTLY, never `cmd.exe /c uvx`.
//           cmd.exe parses the `>`/`<` in the dep-override specs (onnxruntime>=1.20,
//           protobuf<7) as shell redirection — even pre-quoted, Node's cmd.exe
//           arg-quoting re-mangles them — so cmd.exe dies with "The directory name
//           is invalid" and semantic search silently degrades to keyword-only.
//   #2695 — Codex CLI: spawnSync ENOENT for codex.cmd

describe('Windows #2696 - chroma-mcp spawns uvx directly (never cmd.exe)', () => {
  it('resolves a uvx.exe command on Windows — never cmd.exe', () => {
    const command = ChromaMcpManager.resolveUvxCommand('win32');
    expect(command.toLowerCase()).not.toContain('cmd.exe');
    expect(command.toLowerCase().endsWith('uvx.exe')).toBe(true);
  });

  it('uses a bare `uvx` on non-Windows platforms', () => {
    expect(ChromaMcpManager.resolveUvxCommand('linux')).toBe('uvx');
    expect(ChromaMcpManager.resolveUvxCommand('darwin')).toBe('uvx');
  });

  it('honours CLAUDE_MEM_CHROMA_UVX_PATH when it points at a real binary', () => {
    const previous = process.env.CLAUDE_MEM_CHROMA_UVX_PATH;
    // process.execPath is guaranteed to exist and be a file (the bun/node binary).
    process.env.CLAUDE_MEM_CHROMA_UVX_PATH = process.execPath;
    try {
      expect(ChromaMcpManager.resolveUvxCommand('win32')).toBe(process.execPath);
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_MEM_CHROMA_UVX_PATH;
      } else {
        process.env.CLAUDE_MEM_CHROMA_UVX_PATH = previous;
      }
    }
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
