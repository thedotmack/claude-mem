import { expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Real subprocess fixture: the native plugin managers write their own registries. */
function nativeCli(directory: string) {
  const command = join(directory, 'native cli');
  const log = join(directory, 'native-calls.jsonl');
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
const home = process.env.T3_TEST_DRIVER === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, home, secret: process.env.T3_TEST_SECRET}) + '\\n');
if (args[0] === '--version') { console.log('codex-cli 0.156.1'); process.exit(0); }
if (process.env.FAIL_NATIVE_INSTALL === '1') { console.error('fixture plugin install failed'); process.exit(2); }
if (args[0] !== 'plugin') process.exit(3);
if (args[1] === 'marketplace' && args[2] === 'add') {
  const root = args[3];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/marketplace.json')));
  fs.mkdirSync(path.join(home, 'plugins'), {recursive: true});
  fs.writeFileSync(path.join(home, 'plugins', 'known_marketplaces.json'), JSON.stringify({[manifest.name]: {installLocation: root}}));
}
if (args[1] === 'add' || args[1] === 'install') {
  const known = JSON.parse(fs.readFileSync(path.join(home, 'plugins', 'known_marketplaces.json')));
  const root = known.thedotmack.installLocation;
  const version = JSON.parse(fs.readFileSync(path.join(root, 'plugin', '.claude-plugin', 'plugin.json'))).version;
  const marketplace = args[1] === 'add' ? 'claude-mem-local' : 'thedotmack';
  const cache = path.join(home, 'plugins', 'cache', marketplace, 'claude-mem', version);
  for (const file of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.mcp.json', 'scripts/worker-service.cjs', 'scripts/mcp-server.cjs', 'hooks/hooks.json', 'hooks/codex-hooks.json']) {
    const target = path.join(cache, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(path.join(root, 'plugin', file), target);
  }
  if (args[1] === 'add') fs.writeFileSync(path.join(home, 'plugins', 'fixture-codex.json'), JSON.stringify({installed: [{pluginId: args[2], installed: true, version, marketplaceSource: {source: root}}]}));
  else fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({version: 2, plugins: {[args[2]]: [{scope: 'user', installPath: cache, version}]}}));
}
if (args[1] === 'list') {
  if (process.env.T3_TEST_DRIVER === 'claude') {
    const installed = JSON.parse(fs.readFileSync(path.join(home, 'plugins', 'installed_plugins.json'))).plugins;
    console.log(JSON.stringify(Object.entries(installed).flatMap(([id, entries]) => entries.map(entry => ({id, ...entry})))));
  } else console.log(fs.readFileSync(path.join(home, 'plugins', 'fixture-codex.json'), 'utf-8'));
}
if (args[1] === 'install' || args[1] === 'enable') {
  const file = path.join(home, 'settings.json');
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
  if (args[1] === 'enable' && settings.enabledPlugins?.[args[2]] === true) { console.error('plugin is already enabled'); process.exit(1); }
  settings.enabledPlugins = {...settings.enabledPlugins, [args[2]]: true};
  fs.writeFileSync(file, JSON.stringify(settings));
}
`
  );
  chmodSync(command, 0o755);
  return { command, log };
}

it.skipIf(process.platform === 'win32')(
  'migrates only the installed T3 Codex home away from legacy memory context',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 't3-native-context-'));
    try {
      const { command } = nativeCli(directory);
      const home = join(directory, 'codex home');
      const data = join(directory, 'memory data');
      const other = join(directory, 'other home', 'AGENTS.md');
      mkdirSync(home, { recursive: true });
      mkdirSync(data, { recursive: true });
      writeFileSync(
        join(home, 'AGENTS.md'),
        '# User rules\n\n<claude-mem-context>\nstale memory\n</claude-mem-context>\n\n## Keep this\n'
      );
      const context = { mode: 'agents', updateOn: ['session_start', 'session_end'] };
      const watches = [
        {
          name: 'codex',
          schema: 'codex',
          path: join(home, 'sessions/**/*.jsonl'),
          context: { ...context, path: join(home, 'AGENTS.md') },
        },
        { name: 'other-codex', schema: 'codex', context: { ...context, path: other } },
        {
          name: 'project',
          schema: 'codex',
          context: { ...context, path: join(directory, 'project', 'AGENTS.md') },
        },
        { name: 'implicit', schema: 'codex', context },
      ];
      writeFileSync(join(data, 'transcript-watch.json'), JSON.stringify({ version: 1, watches }));
      const settingsPath = join(directory, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify({
          providerInstances: {
            codex: { driver: 'codex', config: { binaryPath: command, homePath: home } },
          },
        })
      );
      const installer = resolve(
        import.meta.dir,
        '../../src/services/integrations/T3CodeInstaller.ts'
      );
      const marketplace = resolve(import.meta.dir, '../..');
      const consumer = join(directory, 'install.ts');
      writeFileSync(
        consumer,
        `import { installT3Code } from ${JSON.stringify(installer)}; const result = await installT3Code(${JSON.stringify(marketplace)}, { settingsPath: ${JSON.stringify(settingsPath)} }); process.exit(result);`
      );
      const result = Bun.spawnSync([process.execPath, consumer], {
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: data },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(join(home, 'config.toml'), 'utf-8')).toContain('enabled = true');
      expect(readFileSync(join(home, 'AGENTS.md'), 'utf-8')).toBe('# User rules\n\n## Keep this\n');
      const restored = JSON.parse(
        readFileSync(join(data, 'transcript-watch.json'), 'utf-8')
      ).watches;
      expect(restored[0].context).toBeUndefined();
      expect(restored.slice(1)).toEqual(watches.slice(1));
      const again = Bun.spawnSync([process.execPath, consumer], {
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: data },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(again.exitCode, again.stderr.toString()).toBe(0);
      expect(readFileSync(join(home, 'AGENTS.md'), 'utf-8')).toBe('# User rules\n\n## Keep this\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
