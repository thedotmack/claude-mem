import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const installer = new URL('../../src/services/integrations/CodexCliInstaller.ts', import.meta.url).href;

for (const mode of ['unset', 'empty', 'absolute', 'relative', 'literal-spaces', 'literal-tilde', 'symlink']) {
  it(`uninstalls from the same Codex home as the host: ${mode}`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-home-contract-')));
    try {
      const owner = join(root, 'owner');
      const fallback = join(owner, '.codex');
      const custom = join(root, mode === 'literal-spaces' ? ' custom codex ' : mode === 'literal-tilde' ? '~/literal' : 'custom-codex');
      mkdirSync(fallback, { recursive: true });
      mkdirSync(custom, { recursive: true });
      const settings = 'model = "owned-model"\n[features]\nhooks = true\n[plugins."claude-mem@claude-mem-local"]\nenabled = true\n[plugins."claude-mem@thedotmack"]\nenabled = true\n';
      const rules = '# Authored rules\n\n<claude-mem-context>\nstale memory\n</claude-mem-context>\n';
      for (const home of [fallback, custom]) {
        writeFileSync(join(home, 'config.toml'), settings);
        writeFileSync(join(home, 'AGENTS.md'), rules);
      }
      const link = join(root, 'linked-codex');
      if (mode === 'symlink') symlinkSync(custom, link, process.platform === 'win32' ? 'junction' : 'dir');
      const script = join(root, 'owned-uninstall.ts');
      writeFileSync(script, `
        import { mock } from 'bun:test';
        import * as originalOs from 'node:os';
        import * as originalFs from 'node:fs';
        import * as originalProcesses from 'node:child_process';
        import { join, sep } from 'node:path';
        const root = process.env.OWNED_CODEX_ROOT;
        const home = process.env.OWNED_DEFAULT_HOME;
        const inheritedHome = process.env.HOME;
        const ownedOs = { ...originalOs, homedir: () => home };
        mock.module('os', () => ({ ...ownedOs, default: ownedOs }));
        mock.module('node:os', () => ({ ...ownedOs, default: ownedOs }));
        const read = originalFs.readFileSync;
        const write = originalFs.writeFileSync;
        const exists = originalFs.existsSync;
        const within = path => typeof path === 'string' && path.startsWith(root + sep);
        const ownedFs = { ...originalFs,
          existsSync: path => within(path) && exists(path),
          writeFileSync: (path, ...args) => {
            if (!within(path)) throw new Error('Refusing a write outside the owned fixture');
            return write(path, ...args);
          } };
        mock.module('fs', () => ({ ...ownedFs, default: ownedFs }));
        mock.module('node:fs', () => ({ ...ownedFs, default: ownedFs }));
        const ownedProcesses = { ...originalProcesses,
          execFileSync: () => { throw new Error('No host binaries in owned fixture'); },
          spawnSync: () => ({ status: 1, stdout: '', stderr: 'No host binaries in owned fixture',
            error: new Error('Owned probe has no Codex executable'), signal: null, pid: 0, output: [] }) };
        mock.module('child_process', () => ({ ...ownedProcesses, default: ownedProcesses }));
        mock.module('node:child_process', () => ({ ...ownedProcesses, default: ownedProcesses }));
        if ((await import('os')).homedir() !== home) throw new Error('Owned HOME mock unavailable');
        const { uninstallCodexCli } = await import(${JSON.stringify(installer)});
        const exit = uninstallCodexCli();
        const snapshot = home => ({ config: Bun.TOML.parse(read(join(home, 'config.toml'), 'utf8')),
          rules: read(join(home, 'AGENTS.md'), 'utf8') });
        console.log('OWNED_CODEX_HOME_RESULT ' + JSON.stringify({ exit,
          fallback: snapshot(join(home, '.codex')), custom: snapshot(process.env.OWNED_CUSTOM_HOME),
          cwd: process.cwd(), configuredHome: process.env.CODEX_HOME,
          systemHomePreserved: process.env.HOME === inheritedHome }));
      `);
      const env = { ...process.env, PATH: '', OWNED_CODEX_ROOT: root, OWNED_DEFAULT_HOME: owner,
        OWNED_CUSTOM_HOME: custom, CLAUDE_CONFIG_DIR: join(root, 'claude'), CLAUDE_MEM_DATA_DIR: join(root, 'data') };
      if (mode === 'unset') delete env.CODEX_HOME;
      else env.CODEX_HOME = mode === 'empty' ? '' : mode === 'relative' ? 'custom-codex'
        : mode === 'literal-spaces' ? ' custom codex ' : mode === 'literal-tilde' ? '~/literal'
        : mode === 'symlink' ? link : custom;
      const child = Bun.spawnSync([process.execPath, script], { cwd: root, env, timeout: 10000 });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const reports = child.stdout.toString().split('\n').filter(line => line.startsWith('OWNED_CODEX_HOME_RESULT '));
      expect(reports).toHaveLength(1);
      const actual = JSON.parse(reports[0].slice('OWNED_CODEX_HOME_RESULT '.length));
      const defaultSelected = mode === 'unset' || mode === 'empty';
      const selected = defaultSelected ? actual.fallback : actual.custom;
      const untouched = defaultSelected ? actual.custom : actual.fallback;
      expect(actual.exit, child.stdout.toString() + child.stderr.toString()).toBe(0);
      expect(actual.systemHomePreserved).toBe(true);
      expect(selected.config.plugins['claude-mem@claude-mem-local'].enabled, child.stdout.toString() + child.stderr.toString()).toBe(false);
      expect(selected.config.plugins['claude-mem@thedotmack'].enabled).toBe(false);
      expect(selected.config.model).toBe('owned-model');
      expect(selected.rules).toContain('# Authored rules');
      expect(selected.rules).not.toContain('<claude-mem-context>');
      expect(untouched.config).toEqual(Bun.TOML.parse(settings));
      expect(untouched.rules).toBe(rules);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
