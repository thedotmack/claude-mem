// Run only in an isolated Bun child. No network, runtimes, or real home writes.
import { spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { strict as assert } from 'assert';
const scratch = mkdtempSync(join(tmpdir(), 'skill-install-'));
try {
  process.env.CLAUDE_CONFIG_DIR = join(scratch, 'config');
  process.env.CLAUDE_MEM_DATA_DIR = join(scratch, 'data');
  delete process.env.CLAUDE_MEM_SKILLS_DISABLED;
  mkdirSync(process.env.CLAUDE_MEM_DATA_DIR);
  const settings = join(process.env.CLAUDE_MEM_DATA_DIR, 'settings.json');
  const pkg = join(scratch, 'package');
  const plugin = join(pkg, 'plugin');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"claude-mem","version":"15.15.2"}');
  writeFileSync(join(plugin, 'package.json'), '{"version":"15.15.2"}');
  writeFileSync(join(pkg, 'package.json'), '{"version":"15.15.2"}');
  for (const name of ['LICENSE', 'NOTICE']) writeFileSync(join(pkg, name), name);
  for (const name of ['make-plan', 'mem-search']) {
    mkdirSync(join(plugin, 'skills', name), { recursive: true });
    writeFileSync(join(plugin, 'skills', name, 'SKILL.md'), `# ${name}`);
  }
  const paths = await import('../../src/npx-cli/utils/paths.js');
  spyOn(paths, 'npmPackageRootDirectory').mockReturnValue(pkg);
  spyOn(paths, 'npmPackagePluginDirectory').mockReturnValue(plugin);
  const { copyPluginToCache, copyPluginToMarketplace } = await import('../../src/npx-cli/commands/install.js');
  const active = (root: string) => join(root, 'skills', 'make-plan', 'SKILL.md');
  const saved = (root: string) => join(root, '.claude-mem-disabled-skills', 'make-plan', 'SKILL.md');
  const marketplace = join(paths.marketplaceDirectory(), 'plugin');
  await copyPluginToCache('15.15.2');
  copyPluginToMarketplace();
  assert(existsSync(active(paths.pluginCacheDirectory('15.15.2'))));
  assert(existsSync(active(marketplace)));
  writeFileSync(settings, JSON.stringify({ CLAUDE_MEM_SKILLS_DISABLED: 'make-plan' }));
  for (const version of ['15.15.2', '15.15.3']) {
    writeFileSync(active(plugin), `updated ${version}`);
    await copyPluginToCache(version);
    copyPluginToMarketplace();
    for (const installed of [paths.pluginCacheDirectory(version), marketplace]) {
      assert(!existsSync(active(installed)));
      assert.equal(readFileSync(saved(installed), 'utf-8'), `updated ${version}`);
      assert(existsSync(join(installed, 'skills', 'mem-search', 'SKILL.md')));
    }
    assert(existsSync(active(plugin)), 'published package must stay intact');
  }
  writeFileSync(settings, '{"CLAUDE_MEM_SKILLS_DISABLED":""}');
  await copyPluginToCache('15.15.3');
  copyPluginToMarketplace();
  assert(existsSync(active(paths.pluginCacheDirectory('15.15.3'))));
  assert(existsSync(active(marketplace)));
  console.log('skill install/update boundaries passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
