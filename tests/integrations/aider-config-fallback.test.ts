import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

for (const insideGit of [true, false]) {
  test(`new Aider config belongs to ${insideGit ? 'the Git root' : 'the current directory'}`, () => {
    // Real path: git reports the resolved root, and macOS's tmpdir sits behind the /var -> /private/var link.
    const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'aider-empty-config-')));
    try {
      const home = path.join(scratch, 'home');
      const project = path.join(scratch, 'project');
      mkdirSync(home);
      mkdirSync(project);
      if (insideGit) execFileSync('git', ['init', '-q'], { cwd: project });
      const cwd = insideGit ? path.join(project, 'packages', 'app') : project;
      mkdirSync(cwd, { recursive: true });
      const resolver = path.resolve(import.meta.dir, '../../src/shared/aider-paths.ts');
      // A fresh process applies HOME/USERPROFILE before os.homedir is read.
      const script = `const { resolveAiderConfigPath } = await import(${JSON.stringify(resolver)});
console.log(resolveAiderConfigPath(${JSON.stringify(cwd)}));`;
      const run = Bun.spawnSync([process.execPath, '-e', script], {
        cwd,
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      expect(run.stdout.toString().trim()).toBe(path.join(project, '.aider.conf.yml'));
      expect(existsSync(path.join(home, '.aider.conf.yml'))).toBe(false);
      expect(existsSync(path.join(cwd, '.aider.conf.yml'))).toBe(false);
      expect(existsSync(path.join(project, '.aider.conf.yml'))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
