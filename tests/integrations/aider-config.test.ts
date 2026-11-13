import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  AIDER_MANAGED_ENTRY_COMMENT,
  AIDER_MARKER_BEGIN,
  AIDER_MARKER_END,
  checkAiderStatus,
  handleAiderCommand,
  hasAiderReadEntry,
  installAiderConfigFile,
  installAiderIntegration,
  refreshAiderMemoryFile,
  removeAiderReadEntry,
  uninstallAiderIntegration,
  upsertAiderReadEntry,
} from '../../src/services/integrations/AiderInstaller.js';
import { AIDER_MEMORY_RELATIVE_PATH } from '../../src/shared/aider-paths.js';

// Aider has no YAML library in this repo and no MCP client or hooks, so the
// installer merges `.aider.conf.yml` `read:` at the text level (Goose
// precedent): every other line — keys, comments, order — stays as written.
// Fixtures are sanitized: placeholder keys only, never real secrets.
const fixturesDir = path.resolve(import.meta.dir, '../fixtures/aider');
const MEMORY = AIDER_MEMORY_RELATIVE_PATH;

const SECRET_KEYS = [
  'sk-PLACEHOLDER-00000000000000000000000000000000',
  'sk-ant-PLACEHOLDER-00000000000000000000000000000000',
];

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function makeProject(): string {
  scratch = mkdtempSync(path.join(tmpdir(), 'aider-install-test-'));
  return scratch;
}

/** Capture console.log/error output for the duration of `fn`. */
function captureConsole(fn: () => unknown): string[] {
  const output: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return output;
}

async function captureConsoleAsync(fn: () => Promise<unknown>): Promise<string[]> {
  const output: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return output;
}

describe('upsertAiderReadEntry', () => {
  test('creates a managed read block in an empty config', () => {
    const merged = upsertAiderReadEntry('', MEMORY);
    expect(merged).toBe(
      `${AIDER_MARKER_BEGIN}\nread:\n  - ${MEMORY}\n${AIDER_MARKER_END}\n`,
    );
  });

  test('appends the managed block after existing keys, preserving order and comments', () => {
    const original = '# my aider setup\nmodel: openai/gpt-4o\nauto-commits: true\n';
    const merged = upsertAiderReadEntry(original, MEMORY);
    expect(merged).toContain('# my aider setup');
    expect(merged).toContain('model: openai/gpt-4o');
    expect(merged).toContain('auto-commits: true');
    expect(merged.indexOf('model:')).toBeLessThan(merged.indexOf(AIDER_MARKER_BEGIN));
    expect(merged).toContain(`  - ${MEMORY}`);
  });

  test('inserts into an existing block list after the last item', () => {
    const original = 'read:\n  - CONVENTIONS.md\n  - docs/ARCHITECTURE.md\n\nauto-commits: true\n';
    const merged = upsertAiderReadEntry(original, MEMORY);
    expect(merged).toBe(
      `read:\n  - CONVENTIONS.md\n  - docs/ARCHITECTURE.md\n  - ${MEMORY}  ${AIDER_MANAGED_ENTRY_COMMENT}\n\nauto-commits: true\n`,
    );
  });

  test('re-install is byte-identical (idempotent)', () => {
    const original = 'read:\n  - CONVENTIONS.md\n';
    const once = upsertAiderReadEntry(original, MEMORY);
    expect(upsertAiderReadEntry(once, MEMORY)).toBe(once);
    expect(once.split(MEMORY).length - 1).toBe(1);
  });

  test('managed-block re-install replaces the block, never duplicates it', () => {
    const once = upsertAiderReadEntry('', MEMORY);
    const twice = upsertAiderReadEntry(once, MEMORY);
    expect(twice).toBe(once);
    expect(twice.split(AIDER_MARKER_BEGIN).length - 1).toBe(1);
  });

  test('a user-added entry for the same file is left alone', () => {
    const original = `read:\n  - ${MEMORY}\n`;
    expect(upsertAiderReadEntry(original, MEMORY)).toBe(original);
  });

  test('appends inside a flow list, preserving the other entries', () => {
    const original = 'read: [CONVENTIONS.md, docs/ARCHITECTURE.md]\n';
    expect(upsertAiderReadEntry(original, MEMORY)).toBe(
      `read: [CONVENTIONS.md, docs/ARCHITECTURE.md, ${MEMORY}]\n`,
    );
  });

  test('flow list already containing the file is unchanged', () => {
    const original = `read: [CONVENTIONS.md, ${MEMORY}]\n`;
    expect(upsertAiderReadEntry(original, MEMORY)).toBe(original);
  });

  test('converts a scalar read entry to a block list, preserving the scalar', () => {
    const original = 'read: CONVENTIONS.md\n';
    expect(upsertAiderReadEntry(original, MEMORY)).toBe(
      `read:\n  - CONVENTIONS.md\n  - ${MEMORY}  ${AIDER_MANAGED_ENTRY_COMMENT}\n`,
    );
  });

  test('converts a quoted scalar, keeping its quoting', () => {
    const original = `read: 'CONVENTIONS.md'\n`;
    expect(upsertAiderReadEntry(original, MEMORY)).toBe(
      `read:\n  - 'CONVENTIONS.md'\n  - ${MEMORY}  ${AIDER_MANAGED_ENTRY_COMMENT}\n`,
    );
  });

  test('a commented-out read key is ignored, not merged into', () => {
    const original = '# read: CONVENTIONS.md\nmodel: openai/gpt-4o\n';
    const merged = upsertAiderReadEntry(original, MEMORY);
    expect(merged).toContain('# read: CONVENTIONS.md');
    expect(merged).toContain(AIDER_MARKER_BEGIN);
  });

  test('a nested read key under another mapping is ignored', () => {
    const original = 'model-settings:\n  read: something-else\n';
    const merged = upsertAiderReadEntry(original, MEMORY);
    expect(merged).toContain('  read: something-else');
    expect(merged).toContain(AIDER_MARKER_BEGIN);
  });

  test('duplicate top-level read keys throw instead of guessing', () => {
    const original = readFileSync(path.join(fixturesDir, 'malformed-duplicate-read.conf.yml'), 'utf-8');
    expect(() => upsertAiderReadEntry(original, MEMORY)).toThrow(/Duplicate top-level `read:`/);
  });

  test('an unclosed flow list throws', () => {
    expect(() => upsertAiderReadEntry('read: [CONVENTIONS.md\n', MEMORY)).toThrow(/flow list/);
  });

  test('a mapping value under read throws', () => {
    expect(() => upsertAiderReadEntry('read: {a: b}\n', MEMORY)).toThrow(/mapping or block value/);
  });

  test('tab indentation in the read list throws', () => {
    expect(() => upsertAiderReadEntry('read:\n\t- CONVENTIONS.md\n', MEMORY)).toThrow(/Tab indentation/);
  });

  test('inconsistent list indentation throws', () => {
    expect(() => upsertAiderReadEntry('read:\n  - CONVENTIONS.md\n    - docs/X.md\n', MEMORY)).toThrow(
      /inconsistent indentation/,
    );
  });

  test('BOM is stripped and the merge still works', () => {
    const merged = upsertAiderReadEntry('\uFEFFmodel: openai/gpt-4o\n', MEMORY);
    expect(merged.startsWith('\uFEFF')).toBe(false);
    expect(merged).toContain('model: openai/gpt-4o');
    expect(merged).toContain(AIDER_MARKER_BEGIN);
  });

  test('CRLF line endings are preserved', () => {
    const merged = upsertAiderReadEntry('model: openai/gpt-4o\r\n', MEMORY);
    expect(merged).toContain('\r\n');
    expect(merged).not.toMatch(/(?<!\r)\n/);
    expect(merged).toContain(AIDER_MARKER_BEGIN);
  });

  test('realistic fixture: keys, comments and Windows path preserved', () => {
    const original = readFileSync(path.join(fixturesDir, 'realistic.conf.yml'), 'utf-8');
    const merged = upsertAiderReadEntry(original, MEMORY);
    for (const key of SECRET_KEYS) expect(merged).toContain(key);
    expect(merged).toContain('# Files Aider always loads');
    expect(merged).toContain('C:\\Users\\alex\\notes\\style-guide.md');
    expect(merged).toContain('dark-mode: true');
    expect(merged).toContain(`  - ${MEMORY}  ${AIDER_MANAGED_ENTRY_COMMENT}`);
    // The user's own read entries keep their order and come first.
    expect(merged.indexOf('CONVENTIONS.md')).toBeLessThan(merged.indexOf(MEMORY));
  });

  test('flow-list fixture merges inside the brackets', () => {
    const original = readFileSync(path.join(fixturesDir, 'flow-list.conf.yml'), 'utf-8');
    const merged = upsertAiderReadEntry(original, MEMORY);
    expect(merged).toContain(`read: [CONVENTIONS.md, docs/ARCHITECTURE.md, ${MEMORY}]`);
    expect(merged).toContain('auto-commits: false');
  });

  test('scalar fixture converts to a block list', () => {
    const original = readFileSync(path.join(fixturesDir, 'scalar.conf.yml'), 'utf-8');
    const merged = upsertAiderReadEntry(original, MEMORY);
    expect(merged).toContain('read:\n  - CONVENTIONS.md\n');
    expect(merged).toContain(`  - ${MEMORY}  ${AIDER_MANAGED_ENTRY_COMMENT}`);
  });
});

describe('removeAiderReadEntry', () => {
  test('removes a managed block and restores the original byte-for-byte', () => {
    const original = 'model: openai/gpt-4o\n\n# comment\n';
    const merged = upsertAiderReadEntry(original, MEMORY);
    expect(removeAiderReadEntry(merged, MEMORY)).toBe(original);
  });

  test('removes only the managed entry from a user list', () => {
    const original = 'read:\n  - CONVENTIONS.md\n  - docs/ARCHITECTURE.md\n';
    const merged = upsertAiderReadEntry(original, MEMORY);
    expect(removeAiderReadEntry(merged, MEMORY)).toBe(original);
  });

  test('leaves an entry without the managed marker alone', () => {
    const original = `read:\n  - CONVENTIONS.md\n  - ${MEMORY}\n`;
    expect(removeAiderReadEntry(original, MEMORY)).toBeNull();
  });

  test('removes the entry from a flow list', () => {
    const original = `read: [CONVENTIONS.md, ${MEMORY}]\n`;
    expect(removeAiderReadEntry(original, MEMORY)).toBe('read: [CONVENTIONS.md]\n');
  });

  test('no entry to remove returns null', () => {
    expect(removeAiderReadEntry('model: openai/gpt-4o\n', MEMORY)).toBeNull();
  });

  test('a scalar read of the memory file is not ours to remove', () => {
    expect(removeAiderReadEntry(`read: ${MEMORY}\n`, MEMORY)).toBeNull();
  });
});

describe('hasAiderReadEntry', () => {
  test('detects managed block, list, flow and scalar forms', () => {
    expect(hasAiderReadEntry(upsertAiderReadEntry('', MEMORY), MEMORY)).toBe(true);
    expect(hasAiderReadEntry(`read:\n  - ${MEMORY}\n`, MEMORY)).toBe(true);
    expect(hasAiderReadEntry(`read: [${MEMORY}]\n`, MEMORY)).toBe(true);
    expect(hasAiderReadEntry(`read: ${MEMORY}\n`, MEMORY)).toBe(true);
    expect(hasAiderReadEntry('model: openai/gpt-4o\n', MEMORY)).toBe(false);
  });
});

describe('installAiderConfigFile', () => {
  test('first install writes the block and backs up owner-only', () => {
    const project = makeProject();
    const configPath = path.join(project, '.aider.conf.yml');
    writeFileSync(configPath, 'model: openai/gpt-4o\n');
    chmodSync(configPath, 0o644);
    expect(installAiderConfigFile(configPath, MEMORY)).toBe(true);
    const config = readFileSync(configPath, 'utf-8');
    expect(config).toContain(AIDER_MARKER_BEGIN);
    expect(config).toContain('model: openai/gpt-4o');
    const backup = readdirSync(project).find((name) => name.startsWith('.aider.conf.yml.bak-'));
    expect(backup).toBeDefined();
    expect(statSync(path.join(project, backup!)).mode & 0o777).toBe(0o600);
  });

  test('second install is a no-op and writes no second backup', () => {
    const project = makeProject();
    const configPath = path.join(project, '.aider.conf.yml');
    writeFileSync(configPath, 'model: openai/gpt-4o\n');
    expect(installAiderConfigFile(configPath, MEMORY)).toBe(true);
    const afterFirst = readFileSync(configPath, 'utf-8');
    expect(installAiderConfigFile(configPath, MEMORY)).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(afterFirst);
    expect(readdirSync(project).filter((name) => name.includes('.bak-'))).toHaveLength(1);
  });

  test('creates the config when none exists', () => {
    const project = makeProject();
    const configPath = path.join(project, '.aider.conf.yml');
    expect(installAiderConfigFile(configPath, MEMORY)).toBe(true);
    expect(readFileSync(configPath, 'utf-8')).toContain(AIDER_MARKER_BEGIN);
    expect(readdirSync(project).filter((name) => name.includes('.bak-'))).toHaveLength(0);
  });

  test('malformed config throws and the file stays untouched', () => {
    const project = makeProject();
    const configPath = path.join(project, '.aider.conf.yml');
    const original = readFileSync(path.join(fixturesDir, 'malformed-duplicate-read.conf.yml'), 'utf-8');
    writeFileSync(configPath, original);
    expect(() => installAiderConfigFile(configPath, MEMORY)).toThrow(/Duplicate top-level `read:`/);
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });
});

describe('install / status / uninstall (integration)', () => {
  const workerDown = async () => {
    throw new Error('Worker is not running');
  };

  test('install creates config + placeholder memory file; status flips; uninstall restores', async () => {
    const project = makeProject();
    const configPath = path.join(project, '.aider.conf.yml');
    const memoryFile = path.join(project, '.claude-mem', 'aider-memory.md');
    writeFileSync(configPath, 'model: openai/gpt-4o\n');

    expect(checkAiderStatus({ configPath })).toBe(1);
    const output = await captureConsoleAsync(async () => {
      expect(await installAiderIntegration({ configPath }, workerDown)).toBe(0);
    });
    expect(output.join('\n')).not.toContain('sk-PLACEHOLDER');
    expect(readFileSync(configPath, 'utf-8')).toContain(AIDER_MARKER_BEGIN);
    expect(existsSync(memoryFile)).toBe(true);
    expect(readFileSync(memoryFile, 'utf-8')).toContain('No context yet');
    expect(checkAiderStatus({ configPath })).toBe(0);

    // Re-install: config byte-identical, no duplicate block.
    const afterFirst = readFileSync(configPath, 'utf-8');
    await captureConsoleAsync(async () => {
      expect(await installAiderIntegration({ configPath }, workerDown)).toBe(0);
    });
    expect(readFileSync(configPath, 'utf-8')).toBe(afterFirst);

    expect(uninstallAiderIntegration({ configPath })).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).toBe('model: openai/gpt-4o\n');
    expect(checkAiderStatus({ configPath })).toBe(1);
    // Memory is the user's data: uninstall never deletes it.
    expect(existsSync(memoryFile)).toBe(true);
  });

  test('install refreshes the memory file when the worker answers', async () => {
    const project = makeProject();
    const configPath = path.join(project, '.aider.conf.yml');
    const memoryFile = path.join(project, '.claude-mem', 'aider-memory.md');
    const fetched = '# Known observation\n\nThe project uses SQLite for local persistence.\n';
    await captureConsoleAsync(async () => {
      expect(await installAiderIntegration({ configPath }, async () => fetched)).toBe(0);
    });
    expect(readFileSync(memoryFile, 'utf-8')).toContain('The project uses SQLite for local persistence');
    expect(readFileSync(memoryFile, 'utf-8')).toContain('<claude-mem-context>');
  });

  test('install succeeds with the placeholder when the worker is down', async () => {
    const project = makeProject();
    const configPath = path.join(project, '.aider.conf.yml');
    let code = -1;
    await captureConsoleAsync(async () => {
      code = await installAiderIntegration({ configPath }, workerDown);
    });
    expect(code).toBe(0);
    expect(readFileSync(path.join(project, '.claude-mem', 'aider-memory.md'), 'utf-8')).toContain('No context yet');
  });

  test('install refuses a malformed config and returns 1 with the file untouched', async () => {
    const project = makeProject();
    const configPath = path.join(project, '.aider.conf.yml');
    const original = readFileSync(path.join(fixturesDir, 'malformed-duplicate-read.conf.yml'), 'utf-8');
    writeFileSync(configPath, original);
    let code = -1;
    const output = await captureConsoleAsync(async () => {
      code = await installAiderIntegration({ configPath }, workerDown);
    });
    expect(code).toBe(1);
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
    expect(output.join('\n')).toContain('Duplicate top-level `read:`');
  });

  test('secret leakage: keys survive in the file and never appear in console output', async () => {
    const project = makeProject();
    const configPath = path.join(project, '.aider.conf.yml');
    const original = readFileSync(path.join(fixturesDir, 'realistic.conf.yml'), 'utf-8');
    writeFileSync(configPath, original);
    const output = await captureConsoleAsync(async () => {
      expect(await installAiderIntegration({ configPath }, workerDown)).toBe(0);
      expect(uninstallAiderIntegration({ configPath })).toBe(0);
    });
    const joined = output.join('\n');
    for (const key of SECRET_KEYS) {
      expect(joined).not.toContain(key);
      expect(readFileSync(configPath, 'utf-8')).toContain(key);
    }
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  test('uninstall with no config is a no-op success', () => {
    const project = makeProject();
    expect(uninstallAiderIntegration({ configPath: path.join(project, '.aider.conf.yml') })).toBe(0);
  });
});

describe('refreshAiderMemoryFile', () => {
  test('writes fetched context into the managed block, preserving user notes', async () => {
    const project = makeProject();
    const configPath = path.join(project, '.aider.conf.yml');
    const memoryFile = path.join(project, '.claude-mem', 'aider-memory.md');
    mkdirSync(path.join(project, '.claude-mem'), { recursive: true });
    writeFileSync(memoryFile, '# My project notes\n\nKeep this.\n');
    const fetched = 'The project uses SQLite for local persistence.';
    expect(await refreshAiderMemoryFile({ configPath }, async () => fetched)).toBe(0);
    const content = readFileSync(memoryFile, 'utf-8');
    expect(content).toContain('# My project notes');
    expect(content).toContain('Keep this.');
    expect(content).toContain('The project uses SQLite for local persistence');
    expect(content).toContain('<claude-mem-context>');

    // Second refresh replaces only the managed block.
    const second = 'The project now uses PostgreSQL for local persistence.';
    expect(await refreshAiderMemoryFile({ configPath }, async () => second)).toBe(0);
    const again = readFileSync(memoryFile, 'utf-8');
    expect(again).toContain('PostgreSQL');
    expect(again).not.toContain('SQLite');
    expect(again).toContain('# My project notes');
    expect(again.split('<claude-mem-context>').length - 1).toBe(1);
  });

  test('worker failure returns 1 and leaves the file untouched', async () => {
    const project = makeProject();
    const configPath = path.join(project, '.aider.conf.yml');
    const memoryFile = path.join(project, '.claude-mem', 'aider-memory.md');
    mkdirSync(path.join(project, '.claude-mem'), { recursive: true });
    writeFileSync(memoryFile, '# My project notes\n');
    let code = -1;
    await captureConsoleAsync(async () => {
      code = await refreshAiderMemoryFile({ configPath }, async () => {
        throw new Error('Worker is not running');
      });
    });
    expect(code).toBe(1);
    expect(readFileSync(memoryFile, 'utf-8')).toBe('# My project notes\n');
  });

  test('empty context is a no-op success, not a wipe', async () => {
    const project = makeProject();
    const configPath = path.join(project, '.aider.conf.yml');
    const memoryFile = path.join(project, '.claude-mem', 'aider-memory.md');
    mkdirSync(path.join(project, '.claude-mem'), { recursive: true });
    writeFileSync(memoryFile, '# My project notes\n');
    expect(await refreshAiderMemoryFile({ configPath }, async () => '   \n')).toBe(0);
    expect(readFileSync(memoryFile, 'utf-8')).toBe('# My project notes\n');
  });
});

describe('handleAiderCommand', () => {
  test('unknown subcommand prints usage and returns 1', async () => {
    const output = await captureConsoleAsync(async () => {
      expect(await handleAiderCommand('bogus', [])).toBe(1);
    });
    expect(output.join('\n')).toContain('Usage: claude-mem aider');
  });

  test('no subcommand prints usage and returns 0', async () => {
    const output = await captureConsoleAsync(async () => {
      expect(await handleAiderCommand(undefined, [])).toBe(0);
    });
    expect(output.join('\n')).toContain('Usage: claude-mem aider');
  });
});
