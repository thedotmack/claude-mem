import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const mode of ['hang', 'success', 'error', 'kill-failure']) {
  it.skipIf(process.platform !== 'win32')(`native Windows npm timeout: ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'cmem native Windows bundle '));
    try {
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, '../src/npx-cli/install/npm-install-helper.ts')],
        target: 'node', format: 'esm', outdir: root, naming: '[name].mjs',
      });
      expect(build.success).toBe(true);
      const result = spawnSync('node', [join(import.meta.dir, 'fixtures/npm-timeout-windows-native.mjs'),
        build.outputs[0].path, mode], { encoding: 'utf8', timeout: 20000, windowsHide: true, shell: false });
      console.log(result.stdout);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 25000);
}
