import { afterAll, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { STALE_ATOMIC_TEMP_FILE_AGE_MS, writeFileAtomic, writeJsonFileAtomic } from '../../src/shared/atomic-json.js';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { applyConfigFileEdit, atomically, removeConfigFile } from '../../src/services/wire-gateway/edit/config-file.js';
import { withExclusiveFileLock } from '../../src/services/wire-gateway/edit/file-lock.js';
import { patchTomlDocument } from '../../src/services/wire-gateway/edit/toml-editor.js';
import { deleteEnvFileKeys, patchEnvDocument } from '../../src/services/wire-gateway/edit/env-editor.js';

const IS_WINDOWS = process.platform === 'win32';
const editTestsRoot = join(WIRE_GATEWAY_DIR, 'tmp', `edit-config-files-${process.pid}-${Date.now()}`);
let testDirCounter = 0;

function freshTestDir(): string {
  const dir = join(editTestsRoot, String(testDirCounter++));
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => rmSync(editTestsRoot, { recursive: true, force: true }));

describe('writeFileAtomic', () => {
  it('writes bytes, keeps the existing mode and leaves no temp file', () => {
    const dir = freshTestDir();
    const target = join(dir, 'config.toml');
    writeFileSync(target, 'old\n');
    if (!IS_WINDOWS) chmodSync(target, 0o640);
    writeFileAtomic(target, new TextEncoder().encode('new\n'));
    expect(readFileSync(target, 'utf-8')).toBe('new\n');
    if (!IS_WINDOWS) expect(statSync(target).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('writes through a symlink, which stays a symlink', () => {
    if (IS_WINDOWS) return;
    const dir = freshTestDir();
    const realFile = join(dir, 'dotfiles-config.json');
    const link = join(dir, 'config.json');
    writeFileSync(realFile, '{}\n');
    symlinkSync(realFile, link);
    writeFileAtomic(link, new TextEncoder().encode('{"a":1}\n'));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(realFile, 'utf-8')).toBe('{"a":1}\n');
  });

  it('edits a hard-linked file in place, so every name sees the write', () => {
    if (IS_WINDOWS) return;
    const dir = freshTestDir();
    const first = join(dir, 'models.yml');
    const second = join(dir, 'overlay-models.yml');
    writeFileSync(first, 'a: 1\n');
    linkSync(first, second);
    const inodeBefore = statSync(first).ino;
    writeFileAtomic(first, new TextEncoder().encode('a: 2\nb: 3\n'));
    expect(readFileSync(second, 'utf-8')).toBe('a: 2\nb: 3\n');
    expect(statSync(first).ino).toBe(inodeBefore);
    expect(statSync(first).nlink).toBe(2);
    writeFileAtomic(first, new TextEncoder().encode('x\n'));
    expect(readFileSync(second, 'utf-8')).toBe('x\n');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('removes its own stale temp files, keeps fresh ones and other files', () => {
    const dir = freshTestDir();
    const target = join(dir, 'config.json');
    const staleTemp = join(dir, '.config.json.4242.abcdef012345.tmp');
    const freshTemp = join(dir, '.config.json.4243.abcdef012345.tmp');
    const otherFilesTemp = join(dir, '.config.json.bak.1.tmp');
    for (const path of [staleTemp, freshTemp, otherFilesTemp]) writeFileSync(path, 'leftover');
    const longAgoSeconds = (Date.now() - STALE_ATOMIC_TEMP_FILE_AGE_MS - 60_000) / 1000;
    utimesSync(staleTemp, longAgoSeconds, longAgoSeconds);
    utimesSync(otherFilesTemp, longAgoSeconds, longAgoSeconds);
    writeFileAtomic(target, new TextEncoder().encode('{}\n'));
    expect(existsSync(staleTemp)).toBe(false);
    expect(existsSync(freshTemp)).toBe(true);
    expect(existsSync(otherFilesTemp)).toBe(true);
  });

  it('writeJsonFileAtomic still writes 2-space JSON with a trailing newline', () => {
    const dir = freshTestDir();
    const target = join(dir, 'state.json');
    writeJsonFileAtomic(target, { a: 1 }, { mode: 0o600 });
    expect(readFileSync(target, 'utf-8')).toBe('{\n  "a": 1\n}\n');
    if (!IS_WINDOWS) expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});

describe('atomically', () => {
  it('puts back every file of a failed group exactly: bytes, mode and absence', () => {
    const dir = freshTestDir();
    const configPath = join(dir, 'config.toml');
    const createdPath = join(dir, 'models.json');
    const configBytes = '# keep\nmodel = "gpt-5"\r\n\r\n[tui]\nnotifications = true\n';
    writeFileSync(configPath, configBytes);
    if (!IS_WINDOWS) chmodSync(configPath, 0o600);
    const stepTwoFailure = new Error('step two');
    expect(() =>
      atomically([configPath, createdPath], () => {
        applyConfigFileEdit(configPath, (bytes) => patchTomlDocument(bytes, { set: [{ keyPath: 'model_providers.cm.base_url', value: 'http://127.0.0.1:37677/r/codex' }] }));
        writeFileAtomic(createdPath, new TextEncoder().encode('{}'));
        if (!IS_WINDOWS) chmodSync(configPath, 0o644);
        throw stepTwoFailure;
      }),
    ).toThrow('step two');
    expect(readFileSync(configPath, 'utf-8')).toBe(configBytes);
    if (!IS_WINDOWS) expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(existsSync(createdPath)).toBe(false);
  });

  it('keeps a successful group and returns its result', () => {
    const dir = freshTestDir();
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, 'a = 1\n');
    const result = atomically([configPath], () => {
      applyConfigFileEdit(configPath, (bytes) => patchTomlDocument(bytes, { set: [{ keyPath: 'b', value: 2 }] }));
      return 'done';
    });
    expect(result).toBe('done');
    expect(readFileSync(configPath, 'utf-8')).toBe('a = 1\nb = 2\n');
  });

  it('refuses a group it could not put back: a path that is not a regular file or cannot be read', () => {
    const dir = freshTestDir();
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, 'a = 1\n');
    let groupRan = false;
    expect(() => atomically([configPath, dir], () => { groupRan = true; })).toThrow('not a regular file');
    if (!IS_WINDOWS && process.getuid?.() !== 0) {
      chmodSync(configPath, 0o000);
      expect(() => atomically([configPath], () => { groupRan = true; })).toThrow('EACCES');
      chmodSync(configPath, 0o644);
    }
    expect(groupRan).toBe(false);
  });

  it('refuses an async group, which would escape the rollback', () => {
    const dir = freshTestDir();
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, 'a = 1\n');
    expect(() => atomically([configPath], () => Promise.resolve())).toThrow('synchronous');
  });
});

describe('applyConfigFileEdit and removeConfigFile', () => {
  it('does not write an unchanged file', () => {
    const dir = freshTestDir();
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, 'a = 1\n');
    const longAgoSeconds = (Date.now() - 3_600_000) / 1000;
    utimesSync(configPath, longAgoSeconds, longAgoSeconds);
    const mtimeBefore = statSync(configPath).mtimeMs;
    expect(applyConfigFileEdit(configPath, (bytes) => patchTomlDocument(bytes, { delete: ['absent'] }))).toBe(false);
    expect(statSync(configPath).mtimeMs).toBe(mtimeBefore);
  });

  it('a refused edit leaves the file untouched', () => {
    const dir = freshTestDir();
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, '[x]\na = 1\n[x]\nb = 2\n');
    expect(() => applyConfigFileEdit(configPath, (bytes) => patchTomlDocument(bytes, { set: [{ keyPath: 'y', value: 1 }] }))).toThrow('defined twice');
    expect(readFileSync(configPath, 'utf-8')).toBe('[x]\na = 1\n[x]\nb = 2\n');
  });

  it('does not create an absent file that an edit leaves empty', () => {
    const dir = freshTestDir();
    const absentPath = join(dir, '.env');
    expect(applyConfigFileEdit(absentPath, (bytes) => patchEnvDocument(bytes, { delete: ['OPENAI_BASE_URL'] }))).toBe(false);
    deleteEnvFileKeys(absentPath, ['OPENAI_BASE_URL'], { fileWasCreatedByClaudeMem: false });
    expect(existsSync(absentPath)).toBe(false);
  });

  it('empties a symlinked or hard-linked file instead of deleting the name', () => {
    if (IS_WINDOWS) return;
    const dir = freshTestDir();
    const target = join(dir, 'AGENTS.md');
    const link = join(dir, 'CLAUDE.md');
    writeFileSync(target, 'text');
    symlinkSync(target, link);
    removeConfigFile(link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('');
    const plain = join(dir, 'plain.env');
    writeFileSync(plain, 'A=1\n');
    removeConfigFile(plain);
    expect(existsSync(plain)).toBe(false);
  });
});

describe('withExclusiveFileLock', () => {
  const editConfigModulePath = join(import.meta.dir, '../../src/services/wire-gateway/edit/file-lock.ts');

  it('serializes read-modify-write across processes', async () => {
    const dir = freshTestDir();
    const counterPath = join(dir, 'counter.txt');
    writeFileSync(counterPath, '0');
    const processCount = 8;
    const incrementsPerProcess = 25;
    const children = Array.from({ length: processCount }, () => Bun.spawn([process.execPath, '-e', `
      const { readFileSync, writeFileSync } = await import('fs');
      const { withExclusiveFileLock } = await import(${JSON.stringify(editConfigModulePath)});
      for (let index = 0; index < ${incrementsPerProcess}; index++) {
        withExclusiveFileLock(${JSON.stringify(counterPath)}, () => {
          const current = Number(readFileSync(${JSON.stringify(counterPath)}, 'utf-8'));
          writeFileSync(${JSON.stringify(counterPath)}, String(current + 1));
        });
      }
    `], { stdout: 'ignore', stderr: 'pipe' }));
    const exitCodes = await Promise.all(children.map((child) => child.exited));
    for (const child of children) expect(await new Response(child.stderr).text()).toBe('');
    expect(exitCodes).toEqual(Array(processCount).fill(0));
    expect(readFileSync(counterPath, 'utf-8')).toBe(String(processCount * incrementsPerProcess));
    expect(existsSync(`${counterPath}.lock`)).toBe(false);
  });

  it('a holder whose lock was broken as stale leaves the next holder\'s lock alone', () => {
    const dir = freshTestDir();
    const lockedPath = join(dir, 'routes.json');
    withExclusiveFileLock(lockedPath, () => {
      // A waiter broke this lock as stale and took its own.
      writeFileSync(`${lockedPath}.lock`, 'another-holder');
    });
    expect(readFileSync(`${lockedPath}.lock`, 'utf-8')).toBe('another-holder');
  });

  it('releases the lock when the mutation throws', () => {
    const dir = freshTestDir();
    const lockedPath = join(dir, 'applied.json');
    expect(() => withExclusiveFileLock(lockedPath, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(`${lockedPath}.lock`)).toBe(false);
  });
});
