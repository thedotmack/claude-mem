import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import * as os from 'os';
import { tmpdir } from 'os';
import path from 'path';
import { getTargetDir, installCursorHooks, uninstallCursorHooks } from '../../src/services/integrations/CursorHooksInstaller.js';

// The user's hooks.json accumulates hooks from other tools, so a write over an
// existing file must replace it rather than truncate it in place: an
// interrupted install or uninstall then cannot leave a half-written hooks.json
// that stops Cursor from loading every hook, including the user's own. An
// in-place truncate keeps the same file; a temp-file-plus-rename write yields
// a new one.
describe('Cursor writes hooks.json atomically', () => {
  let tmp: string;
  let cursorDir: string;
  let hooksJsonPath: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let homedirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'cursor-hooks-atomic-'));
    cursorDir = path.join(tmp, '.cursor');
    hooksJsonPath = path.join(cursorDir, 'hooks.json');
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    homedirSpy = spyOn(os, 'homedir').mockReturnValue(tmp);
    // Fail before any write if the homedir patch did not take: the installer
    // would otherwise drive the real ~/.cursor.
    if (getTargetDir('user') !== cursorDir) {
      throw new Error('homedir patch failed; refusing to run against the real ~/.cursor');
    }
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    homedirSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('replaces hooks.json instead of truncating it in place on install', async () => {
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(hooksJsonPath, JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [{ command: 'my own hook' }] } }, null, 2));
    const first = statSync(hooksJsonPath);

    expect(await installCursorHooks('user')).toBe(0);
    const second = statSync(hooksJsonPath);

    // Either signal proves the file was replaced, not rewritten: a fresh inode
    // on POSIX, or a new creation time where the filesystem reports one.
    expect(second.ino !== first.ino || second.birthtimeMs !== first.birthtimeMs).toBe(true);
    const parsed = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    expect(parsed.hooks.beforeSubmitPrompt.some((hook: { command?: string }) => hook.command === 'my own hook')).toBe(true);
  });

  it('replaces hooks.json instead of truncating it in place on uninstall', async () => {
    mkdirSync(cursorDir, { recursive: true });
    expect(await installCursorHooks('user')).toBe(0);
    // A foreign hook keeps `remaining` non-null, so the uninstall takes the
    // rewrite path instead of unlinking the file outright.
    const withForeign = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    withForeign.hooks.beforeSubmitPrompt.unshift({ command: 'my own hook' });
    writeFileSync(hooksJsonPath, JSON.stringify(withForeign, null, 2));
    const first = statSync(hooksJsonPath);

    expect(uninstallCursorHooks('user')).toBe(0);
    const second = statSync(hooksJsonPath);

    expect(second.ino !== first.ino || second.birthtimeMs !== first.birthtimeMs).toBe(true);
    const parsed = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    expect(parsed.hooks.beforeSubmitPrompt).toEqual([{ command: 'my own hook' }]);
  });
});
