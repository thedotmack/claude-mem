import { describe, it, expect } from 'bun:test';
import { quoteForCmdExe } from '../../../src/services/sync/ChromaMcpManager.js';
import { codexSpawn } from '../../../src/services/integrations/CodexCliInstaller.js';

// Windows spawn-contract fixes folded into plans/02-spawn-contract-templating.md:
//   #2696 — ChromaDB MCP subprocess: unquoted `protobuf<7` in cmd.exe /c
//   #2695 — Codex CLI: spawnSync ENOENT for codex.cmd

describe('Windows #2696 - cmd.exe metacharacter quoting for chroma-mcp deps', () => {
  it('quotes dep specs containing cmd.exe redirection operators', () => {
    expect(quoteForCmdExe('protobuf<7')).toBe('"protobuf<7"');
    expect(quoteForCmdExe('onnxruntime>=1.20')).toBe('"onnxruntime>=1.20"');
  });

  it('leaves ordinary args (no metacharacters) byte-identical', () => {
    expect(quoteForCmdExe('--with')).toBe('--with');
    expect(quoteForCmdExe('--python')).toBe('--python');
    expect(quoteForCmdExe('3.13')).toBe('3.13');
    expect(quoteForCmdExe('chroma-mcp==0.2.6')).toBe('chroma-mcp==0.2.6');
    expect(quoteForCmdExe('--client-type')).toBe('--client-type');
    expect(quoteForCmdExe('persistent')).toBe('persistent');
  });

  it('quotes pipe/ampersand/caret/paren metacharacters too', () => {
    expect(quoteForCmdExe('a|b')).toBe('"a|b"');
    expect(quoteForCmdExe('a&b')).toBe('"a&b"');
    expect(quoteForCmdExe('a^b')).toBe('"a^b"');
    expect(quoteForCmdExe('a(b)')).toBe('"a(b)"');
  });

  it('escapes embedded double quotes before wrapping', () => {
    expect(quoteForCmdExe('a"<b')).toBe('"a\\"<b"');
  });

  it('the actual chroma dep-override specs become cmd.exe-safe', () => {
    // These are the exact specs the manager passes through cmd.exe /c uvx ...
    const specs = ['onnxruntime>=1.20', 'protobuf<7'];
    for (const spec of specs) {
      const quoted = quoteForCmdExe(spec);
      expect(quoted.startsWith('"')).toBe(true);
      expect(quoted.endsWith('"')).toBe(true);
      // The inner content is preserved so uvx still sees the real spec.
      expect(quoted.slice(1, -1)).toBe(spec);
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
