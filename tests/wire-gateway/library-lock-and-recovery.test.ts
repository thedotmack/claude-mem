import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { libraryChildEnvironment, runLibraryInBunChild } from '../../src/npx-cli/commands/library.js';
import {
  LIBRARY_BACKUPS_KEPT,
  LIBRARY_CHANGE_ID_ENV,
  LibraryBackupChange,
  libraryBackupChangeFolders,
  libraryBackupsDirectory,
  pruneLibraryBackups,
} from '../../src/services/wire-gateway/library/backups.js';
import { removeRecordedItemsOnly } from '../../src/services/wire-gateway/library/library-cli.js';
import { applyLibrary, removeLibrary } from '../../src/services/wire-gateway/library/library-engine.js';
import { libraryRecordPath, readLibraryRecords, sha256Hex } from '../../src/services/wire-gateway/library/library-record.js';
import { applyLibraryForInstaller } from '../../src/services/wire-gateway/library/library-runtime.js';
import { LIBRARY_RECOVERY_NOTE_PREFIX, SCRIPT_PATH_NOT_FOUND_FOR_REMOVAL, libraryRecoveryNotesIn, type ConfigMemberItem } from '../../src/services/wire-gateway/library/types.js';

// The Phase 14 re-review fixes: a stalled holder keeps library.json's lock
// (P2-1), a rollback that fails is kept and explained (P3-1, P3-2), recovery
// notes reach the user (P3-3), `library remove` reports (P3-4), one command
// is one backup folder ordered by sequence (P3-5), and two guards that had
// no test (P3-6).

const ROOT = join(WIRE_GATEWAY_DIR, 'tmp', `library-lock-and-recovery-${process.pid}`);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
let counter = 0;

function sandbox(): { dir: string; context: { libraryDirectory: string } } {
  const dir = join(ROOT, String(counter++));
  mkdirSync(dir, { recursive: true });
  return { dir, context: { libraryDirectory: join(dir, 'library') } };
}

const read = (path: string) => readFileSync(path, 'utf-8');
/** The repo's built worker-service.cjs (`npm run build`), which the `library` CLI and the npx Bun children run. */
const WORKER_SERVICE_BUILD = join(import.meta.dir, '..', '..', 'plugin', 'scripts', 'worker-service.cjs');
const flag = (file: string, id = 'setting:flag'): ConfigMemberItem => ({ kind: 'setting', id, group: 'settings', place: 'member', file, format: 'json', keyPath: ['plugins', 'claude-mem'], value: true, whenUnrecorded: 'replace-and-stash' });

/** Run `fn` with console.log/error captured. */
function captureConsole<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    return { result: fn(), lines };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

async function captureConsoleAsync<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

/** library.json as a crash left it: `file` holds what the change wrote, its bytes before were `before`. */
function writeCrashedPendingChange(libraryDirectory: string, file: string, written: string, before: string | null): void {
  mkdirSync(libraryDirectory, { recursive: true });
  writeFileSync(file, written);
  writeFileSync(libraryRecordPath(libraryDirectory), JSON.stringify({
    version: 1,
    agents: {},
    pendingChange: { agentId: 'crashed', at: '2026-01-01T00:00:00.000Z', files: [{ path: file, bytesBeforeBase64: before === null ? null : Buffer.from(before).toString('base64'), writtenSha256: sha256Hex(written) }] },
  }));
}

describe('a holder that stalls keeps library.json\'s lock (P2-1)', () => {
  /** The stalled child sleeps this long after writing its files: long enough that the parent is surely waiting on the lock meanwhile. */
  const STALL_MS = 1_500;
  /** Bun start plus one change plus the stall, on a loaded CI box; the bound reports a hang. */
  const CHILD_TIMEOUT_MS = 60_000;

  it('a second change waits for the stalled one instead of breaking its lock: both are written and both recorded', async () => {
    const { dir, context } = sandbox();
    const stalledFile = join(dir, 'stalled.json');
    const otherFile = join(dir, 'other.json');
    writeFileSync(stalledFile, '{\n  "theme": "dark"\n}\n');
    writeFileSync(otherFile, '{\n  "theme": "light"\n}\n');
    const marker = join(dir, 'stalling');
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'library', 'stall-mid-change.ts'), context.libraryDirectory, stalledFile, marker, String(STALL_MS)], { stdout: 'pipe', stderr: 'pipe' });
    const waitUntil = Date.now() + CHILD_TIMEOUT_MS;
    while (!existsSync(marker)) {
      if (Date.now() > waitUntil) throw new Error('the stalling child never wrote its files');
      await Bun.sleep(10);
    }

    // The stalled holder's lock looks a minute old; it must not be broken.
    const other = applyLibrary({ agentId: 'other', items: [flag(otherFile)], ownedGroups: ['settings'] }, context);
    const exitCode = await child.exited;
    const childStderr = await new Response(child.stderr).text();
    const stalled = JSON.parse(await new Response(child.stdout).text());

    expect({ exitCode, childStderr }).toEqual({ exitCode: 0, childStderr: '' });
    expect(other.recoveryNotes).toBeUndefined();
    expect(stalled.filesWritten).toEqual([stalledFile]);
    expect(JSON.parse(read(stalledFile)).plugins['claude-mem']).toBe(true);
    expect(JSON.parse(read(otherFile)).plugins['claude-mem']).toBe(true);
    const recordFile = JSON.parse(read(libraryRecordPath(context.libraryDirectory)));
    expect(Object.keys(recordFile.agents).sort()).toEqual(['other', 'stalled']);
    expect(recordFile.pendingChange).toBeUndefined();
  });

  it('a change whose lock was taken away refuses to commit: nothing is recorded and the pending change stays for the next command', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'settings.json');
    const original = '{\n  "theme": "dark"\n}\n';
    writeFileSync(file, original);
    const lockPath = `${libraryRecordPath(context.libraryDirectory)}.lock`;
    let error: Error | null = null;
    try {
      applyLibrary({ agentId: 'agent', items: [flag(file)], ownedGroups: ['settings'] }, {
        ...context,
        // Another process took the lock while this change was writing.
        afterConfigFilesWritten: () => writeFileSync(lockPath, JSON.stringify({ token: 'thief', pid: process.pid, host: 'elsewhere', startToken: null })),
      });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toContain('lost the lock on library.json');
    const recordFile = JSON.parse(read(libraryRecordPath(context.libraryDirectory)));
    expect(recordFile.agents.agent).toBeUndefined();
    expect(recordFile.pendingChange.files.map((entry: { path: string }) => entry.path)).toEqual([file]);
    // The thief's lock is left alone; once it is gone the next command rolls the change back.
    expect(JSON.parse(read(lockPath)).token).toBe('thief');
    rmSync(lockPath);
    const next = removeLibrary({ agentId: 'agent', items: [] }, context);
    expect(next.recoveryNotes?.[0]).toContain(`${file}: put back as it was`);
    expect(read(file)).toBe(original);
  });
});

describe('a rollback that fails is kept and explained (P3-1, P3-2)', () => {
  it('a throw after writing, where putting the file back also fails, keeps the pending change, so the next command still puts the file back', () => {
    const { dir, context } = sandbox();
    const configDir = join(dir, 'cfg');
    mkdirSync(configDir);
    const file = join(configDir, 'settings.json');
    const original = '{\n  "theme": "dark"\n}\n';
    writeFileSync(file, original);
    let error: Error | null = null;
    try {
      applyLibrary({ agentId: 'agent', items: [flag(file)], ownedGroups: ['settings'] }, {
        ...context,
        afterConfigFilesWritten: () => {
          chmodSync(configDir, 0o555);
          throw new Error('simulated failure after write');
        },
      });
    } catch (caught) {
      error = caught as Error;
    } finally {
      chmodSync(configDir, 0o755);
    }
    expect(error?.message).toContain('could not be put back');
    expect(error?.message).toContain('keeps this change as pending');
    // The file still holds claude-mem's write, and library.json still says so.
    expect(JSON.parse(read(file)).plugins['claude-mem']).toBe(true);
    const recordFile = JSON.parse(read(libraryRecordPath(context.libraryDirectory)));
    expect(recordFile.pendingChange.files.map((entry: { path: string }) => entry.path)).toEqual([file]);
    expect(recordFile.agents.agent).toBeUndefined();

    const next = removeLibrary({ agentId: 'agent', items: [flag(file)] }, context);
    expect(next.recoveryNotes?.[0]).toContain(`${file}: put back as it was`);
    expect(read(file)).toBe(original);
  });

  it('a pending change that cannot be rolled back stops commands with a message naming library.json, the change, its files and the way out', () => {
    const { dir, context } = sandbox();
    const readOnly = join(dir, 'ro');
    mkdirSync(readOnly);
    const file = join(readOnly, 'a.json');
    writeCrashedPendingChange(context.libraryDirectory, file, '{"plugins":{"claude-mem":true}}', '{}');
    chmodSync(readOnly, 0o555);
    const other = join(dir, 'other.json');
    writeFileSync(other, '{}');
    let message = '';
    try {
      applyLibrary({ agentId: 'unrelated', items: [flag(other)], ownedGroups: ['settings'] }, context);
    } catch (caught) {
      message = (caught as Error).message;
    } finally {
      chmodSync(readOnly, 0o755);
    }
    const recordPath = libraryRecordPath(context.libraryDirectory);
    expect(message).toContain(`${recordPath} holds an interrupted change (agent crashed, 2026-01-01T00:00:00.000Z) that could not be rolled back`);
    expect(message).toContain(`Files of that change: ${file}.`);
    expect(message).toContain('make those files and their folders writable again and rerun the command');
    expect(message).toContain(`delete the "pendingChange" entry from ${recordPath} by hand`);
    expect(read(other)).toBe('{}');
    // Once writable, the next command rolls it back and goes on.
    const recovered = applyLibrary({ agentId: 'unrelated', items: [flag(other)], ownedGroups: ['settings'] }, context);
    expect(recovered.recoveryNotes?.[0]).toContain(`${file}: put back as it was`);
    expect(read(file)).toBe('{}');
  });
});

describe('recovery notes reach the user (P3-3)', () => {
  it('an installer\'s Library call prints each note on its own prefixed line, which captured output gives back', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'a.json');
    writeCrashedPendingChange(context.libraryDirectory, file, '{"plugins":{"claude-mem":true}}', '{}');
    const other = join(dir, 'other.json');
    writeFileSync(other, '{}');
    const { result, lines } = captureConsole(() => applyLibraryForInstaller({ agentId: 'agent', items: [flag(other)], ownedGroups: ['settings'] }, context));
    expect(result.recoveryNotes).toHaveLength(1);
    expect(lines).toEqual([`${LIBRARY_RECOVERY_NOTE_PREFIX}${result.recoveryNotes![0]}`]);
    expect(libraryRecoveryNotesIn(`installing…\n${lines.join('\n')}\ndone\n`)).toEqual(result.recoveryNotes!);
  });

  it('`library remove` of an agent without an uninstaller shows the notes too', async () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'a.json');
    writeCrashedPendingChange(context.libraryDirectory, file, '{"plugins":{"claude-mem":true}}', '{}');
    const { result, lines } = await captureConsoleAsync(() => removeRecordedItemsOnly('warp', context));
    expect(result).toBe(0);
    expect(libraryRecoveryNotesIn(lines.join('\n'))).toEqual([`${file}: put back as it was before an interrupted claude-mem Library change (crashed, 2026-01-01T00:00:00.000Z)`]);
  });
});

describe('`library remove` reports what it did (P3-4)', () => {
  it('says what it removed and exits 0', async () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'mcp.json');
    writeFileSync(file, '{}\n');
    applyLibrary({ agentId: 'roo-code', items: [{ ...flag(file, 'mcp:claude-mem'), kind: 'mcp', group: 'mcp' }], ownedGroups: ['mcp'] }, context);
    const { result, lines } = await captureConsoleAsync(() => removeRecordedItemsOnly('roo-code', context));
    expect(result).toBe(0);
    expect(lines.some((line) => line.includes('mcp:claude-mem'))).toBe(true);
    expect(lines.at(-1)).toContain('claude-mem removed');
    expect(read(file)).toBe('{}\n');
  });

  it('says when nothing was recorded', async () => {
    const { context } = sandbox();
    const { result, lines } = await captureConsoleAsync(() => removeRecordedItemsOnly('copilot-cli', context));
    expect(result).toBe(0);
    expect(lines).toEqual(['Copilot CLI: nothing recorded; claude-mem has nothing to remove here']);
  });

  it('`claude-mem library remove warp` exits nonzero and says why when the remove fails', () => {
    // The real CLI, in a child with its own data dir (so its library.json is this test's alone).
    const { dir } = sandbox();
    const dataDirectory = join(dir, 'data');
    const libraryDirectory = join(dataDirectory, 'wire-gateway', 'library');
    mkdirSync(libraryDirectory, { recursive: true });
    writeFileSync(libraryRecordPath(libraryDirectory), '{ broken');
    const child = spawnSync(process.execPath, [WORKER_SERVICE_BUILD, 'library', 'remove', 'warp'], { encoding: 'utf-8', env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDirectory, HOME: join(dir, 'home') }, timeout: 60_000 });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('Warp: removing claude-mem failed:');
    expect(child.stderr).toContain('cannot be read');
  });

  it('Grok Bot\'s remove goes through the same reporting', async () => {
    const { context } = sandbox();
    mkdirSync(context.libraryDirectory, { recursive: true });
    writeFileSync(libraryRecordPath(context.libraryDirectory), '{ broken');
    const { result, lines } = await captureConsoleAsync(() => removeRecordedItemsOnly('grok-bot', context));
    expect(result).toBe(1);
    expect(lines[0]).toStartWith('Grok Bot: removing claude-mem failed:');
  });
});

describe('one user command is one backup folder, ordered by sequence (P3-5)', () => {
  it('the npx parent gives every Bun child the same change id', () => {
    const first = libraryChildEnvironment({ PATH: '/usr/bin' }, '/node')[LIBRARY_CHANGE_ID_ENV];
    const second = libraryChildEnvironment({ PATH: '/usr/bin' }, '/node')[LIBRARY_CHANGE_ID_ENV];
    expect(first).toMatch(/^[A-Za-z0-9-]+$/);
    expect(second).toBe(first);
    // A change id the caller already has (a nested command) is passed on.
    expect(libraryChildEnvironment({ [LIBRARY_CHANGE_ID_ENV]: 'outer-1' }, '/node')[LIBRARY_CHANGE_ID_ENV]).toBe('outer-1');
  });

  it('two Library processes of one command keep their backups in one folder', () => {
    const { dir, context } = sandbox();
    const changeId = 'one-command-1';
    for (const agent of ['first', 'second']) {
      const file = join(dir, `${agent}.json`);
      writeFileSync(file, `{"agent":"${agent}"}`);
      const child = spawnSync(process.execPath, ['-e', `
        const { applyLibrary } = await import(${JSON.stringify(join(import.meta.dir, '../../src/services/wire-gateway/library/library-engine.ts'))});
        applyLibrary({ agentId: ${JSON.stringify(agent)}, items: [${JSON.stringify(flag(file))}], ownedGroups: ['settings'] }, { libraryDirectory: ${JSON.stringify(context.libraryDirectory)} });
      `], { encoding: 'utf-8', env: { ...process.env, [LIBRARY_CHANGE_ID_ENV]: changeId }, timeout: 60_000 });
      expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
    }
    const folders = libraryBackupChangeFolders(context.libraryDirectory);
    expect(folders).toHaveLength(1);
    expect(folders[0]).toEndWith(`_${changeId}`);
    expect(readdirSync(join(libraryBackupsDirectory(context.libraryDirectory), folders[0])).sort()).toEqual(['first', 'second']);
  });

  it('a clock set back (DST fall-back) never makes the newest folder sort oldest: folders keep the order they were made in', () => {
    const { context } = sandbox();
    const encoder = new TextEncoder();
    // Each change an hour EARLIER by the wall clock than the one before it.
    for (let index = 0; index < LIBRARY_BACKUPS_KEPT + 3; index++) {
      const change = new LibraryBackupChange(context.libraryDirectory, () => new Date(Date.UTC(2026, 10, 1, 9, -index)));
      change.keep('agent', join(context.libraryDirectory, 'cfg.json'), encoder.encode(`change ${index}`));
    }
    expect(pruneLibraryBackups(context.libraryDirectory)).toBe(3);
    const folders = libraryBackupChangeFolders(context.libraryDirectory);
    expect(folders).toHaveLength(LIBRARY_BACKUPS_KEPT);
    const contents = folders.map((name) => read(join(libraryBackupsDirectory(context.libraryDirectory), name, 'agent', join(context.libraryDirectory, 'cfg.json').replace(/^\/+/, ''))));
    expect(contents[0]).toBe('change 3');
    expect(contents.at(-1)).toBe(`change ${LIBRARY_BACKUPS_KEPT + 2}`);
  });

  it('folders from before the sequence count as older than numbered ones', () => {
    const { context } = sandbox();
    const root = libraryBackupsDirectory(context.libraryDirectory);
    mkdirSync(join(root, '2030-01-01_00-00-00.000'), { recursive: true });
    new LibraryBackupChange(context.libraryDirectory, () => new Date(Date.UTC(2020, 0, 1)), 'new-1').keep('agent', '/x.json', new TextEncoder().encode('x'));
    expect(libraryBackupChangeFolders(context.libraryDirectory)).toEqual(['2030-01-01_00-00-00.000', '000001_new-1']);
  });
});

describe('guards that had no test (P3-6)', () => {
  it('a remove\'s script-path placeholder is never written into a config', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'hooks.json');
    writeFileSync(file, '{}\n');
    const placeholder: ConfigMemberItem = { ...flag(file, 'hook:stop'), kind: 'hook', group: 'hooks', value: `node ${SCRIPT_PATH_NOT_FOUND_FOR_REMOVAL} stop` };
    expect(() => applyLibrary({ agentId: 'agent', items: [placeholder], ownedGroups: ['hooks'] }, context)).toThrow('claude-mem\'s script path was not found');
    expect(read(file)).toBe('{}\n');
    expect(readLibraryRecords(context.libraryDirectory).agent).toBeUndefined();
  });

  it('a Library child\'s output over spawnSync\'s default 1 MB cap is captured whole, not cut off', () => {
    // `library status --json` of an agent with many recorded items prints well over 1 MB.
    // The child gets its own data dir (it inherits this process's env), so its library.json is this test's alone.
    const { dir } = sandbox();
    const dataDirectory = join(dir, 'data');
    const libraryDirectory = join(dataDirectory, 'wire-gateway', 'library');
    const recordPath = libraryRecordPath(libraryDirectory);
    mkdirSync(libraryDirectory, { recursive: true });
    const longPath = join(ROOT, 'x'.repeat(200), 'settings.json');
    /** Items × ~400 bytes of status JSON each ≈ 2 MB, twice spawnSync's default maxBuffer (1024 × 1024). */
    const recordedItemCount = 5_000;
    const settings = Array.from({ length: recordedItemCount }, (_, index) => ({ id: `setting:item-${index}`, kind: 'setting', group: 'settings', place: 'member', path: longPath, keyPath: ['k', String(index)], writtenSha256: '0'.repeat(64) }));
    writeFileSync(recordPath, JSON.stringify({ version: 1, agents: { warp: { at: '2026-01-01T00:00:00.000Z', hooks: [], mcp: [], settings, instructions: [], skills: [], bundles: [], files: {} } } }));
    const previousDataDirectory = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = dataDirectory;
    try {
      const child = runLibraryInBunChild(['status', 'warp', '--json'], WORKER_SERVICE_BUILD);
      expect(child.output.length).toBeGreaterThan(1024 * 1024);
      expect(child.result).toBe(0);
      // A fresh data dir adds a `[SETTINGS] Created settings file` notice on stderr, after stdout in the capture.
      const report = JSON.parse(child.output.split('\n').filter((line) => !line.startsWith('[SETTINGS]')).join('\n'));
      expect(report[0].items).toHaveLength(recordedItemCount);
    } finally {
      if (previousDataDirectory === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
      else process.env.CLAUDE_MEM_DATA_DIR = previousDataDirectory;
    }
  });
});
