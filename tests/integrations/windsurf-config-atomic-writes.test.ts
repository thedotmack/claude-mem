import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeWindsurfContextFile } from '../../src/services/integrations/WindsurfHooksInstaller.js';

const INSTALLER = path.resolve(
  import.meta.dir,
  '../../src/services/integrations/WindsurfHooksInstaller.js',
);

// Windsurf's hooks.json accumulates hooks from other tools, so a rewrite must
// replace the file rather than truncate it in place: an interrupted install or
// uninstall then cannot leave a half-written hooks.json that stops Windsurf
// from loading every hook, including the user's own. An in-place truncate keeps
// the same file; a temp-file-plus-rename write yields a new one. The installer
// resolves ~/.codeium from `os.homedir()` at import time, so the check runs in
// a child process with an isolated HOME — the same shape the local installers
// are validated in, and it never touches the developer's real ~/.codeium.
describe('Windsurf writes user config atomically', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'windsurf-atomic-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('replaces hooks.json instead of truncating it in place on uninstall', () => {
    const home = path.join(tmp, 'home');
    const hooksDir = path.join(home, '.codeium', 'windsurf');
    const hooksJsonPath = path.join(hooksDir, 'hooks.json');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(hooksJsonPath, JSON.stringify({
      hooks: {
        pre_user_prompt: [
          { command: 'my own hook', show_output: false },
          { command: '"bun" "worker-service.cjs" windsurf session-init', show_output: false },
        ],
      },
    }, null, 2));

    const script = `
      console.log = () => {};
      console.error = () => {};
      import { statSync, readFileSync } from 'node:fs';
      const { uninstallWindsurfHooks } = await import(${JSON.stringify(INSTALLER)});
      const file = ${JSON.stringify(hooksJsonPath)};
      const before = statSync(file);
      const code = uninstallWindsurfHooks();
      const after = statSync(file);
      process.stdout.write(JSON.stringify({
        code,
        beforeIno: before.ino,
        beforeBirth: before.birthtimeMs,
        afterIno: after.ino,
        afterBirth: after.birthtimeMs,
        text: readFileSync(file, 'utf-8'),
      }));
    `;
    const scriptPath = path.join(tmp, 'uninstall-child.mjs');
    writeFileSync(scriptPath, script);

    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CLAUDE_MEM_DATA_DIR: path.join(home, '.claude-mem'),
    };
    let stdout: string;
    try {
      // `cwd: tmp` keeps uninstallWindsurfHooks()'s workspace cleanup inside the
      // temporary directory: it deletes <cwd>/.windsurf/rules/claude-mem-context.md
      // when that file exists, so an inherited working directory would let the
      // test delete a real checkout's context file.
      stdout = execFileSync(process.execPath, [scriptPath], { cwd: tmp, env, encoding: 'utf-8', timeout: 60000 });
    } catch (error) {
      throw new Error(`windsurf uninstall child failed: ${(error as { stderr?: string }).stderr ?? String(error)}`);
    }

    const result = JSON.parse(stdout) as {
      code: number;
      beforeIno: number;
      beforeBirth: number;
      afterIno: number;
      afterBirth: number;
      text: string;
    };

    expect(result.code).toBe(0);
    // Either signal proves the file was replaced, not rewritten: a fresh inode
    // on POSIX, or a new creation time where the filesystem reports one.
    expect(result.afterIno !== result.beforeIno || result.afterBirth !== result.beforeBirth).toBe(true);
    const parsed = JSON.parse(result.text) as { hooks: { pre_user_prompt: Array<{ command: string }> } };
    expect(parsed.hooks.pre_user_prompt).toEqual([{ command: 'my own hook', show_output: false }]);
  });

  it('keeps the context char limit and its truncation note', () => {
    const workspace = path.join(tmp, 'workspace-long');
    const rulesFile = path.join(workspace, '.windsurf', 'rules', 'claude-mem-context.md');

    writeWindsurfContextFile(workspace, 'x'.repeat(7000));

    const text = readFileSync(rulesFile, 'utf-8');
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).toContain('[Truncated');
  });
});
