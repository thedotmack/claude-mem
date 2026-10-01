import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';
import {
  codexSpawn,
  isExecutableFile,
  isUsableCodexBundle,
  lookupCodexOnMacOS,
  resolveCodexCommand,
  resolveCodexSpawnInvocation,
} from '../../../src/services/integrations/CodexCliInstaller.js';
import { buildSpawnSyncInvocation } from '../../../src/shared/spawn.js';

// Windows spawn-contract fixes:
//   #2696 — ChromaDB MCP subprocess: spawn uvx.exe DIRECTLY, never `cmd.exe /c uvx`.
//           cmd.exe parses the `>`/`<` in the dep-override specs (onnxruntime>=1.20,
//           protobuf<7) as shell redirection — even pre-quoted, Node's cmd.exe
//           arg-quoting re-mangles them — so cmd.exe dies with "The directory name
//           is invalid" and semantic search silently degrades to keyword-only.
//   #2695 — Codex CLI: spawnSync ENOENT for codex.cmd

describe('Windows #2696 - chroma-mcp spawns uvx directly', () => {
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
    expect(resolveCodexCommand('darwin', () => null, () => null)).toBe('codex');
  });

  it('codexSpawn resolves codex from PATH and runs it (a stub, never the real CLI)', () => {
    // The contract under test is that codexSpawn resolves the command (through
    // `where` to the .cmd shim on Windows, #2695) and returns a SpawnSyncReturns
    // rather than throwing. A stub first on PATH keeps it off whatever codex the
    // machine has: running the real `codex --version` timed out under load.
    //
    // Bun's spawnSync resolves a command, and builds the child's environment,
    // from the environment the process started with, not from later edits to
    // process.env, and codexSpawn passes no env. So the call runs in a child
    // started with the stub first on PATH.
    const stubDir = mkdtempSync(join(tmpdir(), 'codex-stub-'));
    try {
      if (process.platform === 'win32') {
        writeFileSync(join(stubDir, 'codex.cmd'), '@echo codex-cli 0.0.0-stub\r\n');
      } else {
        writeFileSync(join(stubDir, 'codex'), '#!/bin/sh\necho "codex-cli 0.0.0-stub"\n');
        chmodSync(join(stubDir, 'codex'), 0o755);
      }
      const installer = join(import.meta.dir, '../../../src/services/integrations/CodexCliInstaller.ts');
      const probe = join(stubDir, 'probe.ts');
      writeFileSync(probe, [
        `import { codexSpawn } from ${JSON.stringify(installer)};`,
        `const result = codexSpawn(['--version']);`,
        `process.stdout.write(JSON.stringify({ status: result.status, stdout: result.stdout, error: result.error ? String(result.error) : null }));`,
      ].join('\n'));

      const child = spawnSync(process.execPath, [probe], {
        encoding: 'utf-8',
        env: { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}` },
        timeout: 30_000,
      });

      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.error).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('codex-cli 0.0.0-stub');
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('macOS Codex Desktop bundle resolution', () => {
  const chatGptBundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const legacyBundledCodex = '/Applications/Codex.app/Contents/Resources/codex';

  it('rejects bundle files that are not executable', () => {
    expect(isExecutableFile(chatGptBundledCodex, () => {
      throw new Error('EACCES');
    })).toBe(false);
    expect(isExecutableFile(chatGptBundledCodex, () => {})).toBe(true);
  });

  it('keeps a standalone codex from PATH as the first choice', () => {
    expect(lookupCodexOnMacOS(() => true, () => true)).toBe('codex');
  });

  it('prefers the current ChatGPT app bundle when both app bundles exist', () => {
    expect(lookupCodexOnMacOS(
      () => false,
      () => true,
    )).toBe(chatGptBundledCodex);
  });

  it('supports the legacy Codex app bundle when ChatGPT is absent', () => {
    expect(lookupCodexOnMacOS(
      () => false,
      (candidate) => candidate === legacyBundledCodex,
    )).toBe(legacyBundledCodex);
  });

  it('falls back to the legacy bundle when the ChatGPT bundled CLI probe fails', () => {
    const probed: string[] = [];
    expect(lookupCodexOnMacOS(
      () => false,
      (candidate) => {
        probed.push(candidate);
        return candidate === legacyBundledCodex;
      },
    )).toBe(legacyBundledCodex);
    expect(probed).toEqual([chatGptBundledCodex, legacyBundledCodex]);
  });

  it('bounds the bundled CLI probe and force-kills a hung candidate', () => {
    const probe = ((_command: string, _args: string[], options: { timeout?: number; killSignal?: string }) => {
      expect(options.timeout).toBe(5_000);
      expect(options.killSignal).toBe('SIGKILL');
      return { error: new Error('ETIMEDOUT'), status: null };
    }) as typeof import('child_process').spawnSync;

    expect(isUsableCodexBundle(chatGptBundledCodex, probe)).toBe(false);
  });

  it('returns after the deadline when the bundled CLI ignores SIGTERM', () => {
    if (process.platform === 'win32') return;

    const probe = ((_command: string, _args: string[], options: Parameters<typeof spawnSync>[2]) => (
      spawnSync(process.execPath, ['-e', [
        "process.on('SIGTERM', () => {});",
        'setTimeout(() => process.exit(17), 3_000);',
        'setInterval(() => {}, 1_000);',
      ].join('')], {
        ...options,
        timeout: 200,
      })
    )) as typeof spawnSync;

    const startedAt = Date.now();
    expect(isUsableCodexBundle(chatGptBundledCodex, probe)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('passes the bundled CLI path through the shared spawn resolver', () => {
    const invocation = resolveCodexSpawnInvocation(
      ['--version'],
      'darwin',
      () => null,
      () => chatGptBundledCodex,
    );

    expect(invocation.command).toBe(chatGptBundledCodex);
    expect(invocation.args).toEqual(['--version']);
  });
});
