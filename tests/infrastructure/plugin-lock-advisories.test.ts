import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), 'utf-8');
}

function resolvedInPluginLock(name: string): string | undefined {
  return read('plugin/bun.lock').match(new RegExp(`"${name}": \\["${name}@([^"]+)"`))?.[1];
}

// #6211: plugin/bun.lock resolved adm-zip 0.5.18 (through onnxruntime-node's
// `^0.5.16`) and zod 4.4.3, both with High advisories. build-hooks.js writes
// plugin/package.json and the lockfile is regenerated from it, so the override
// and the zod floor must live there too or the next build brings them back.
describe('plugin runtime closure advisories', () => {
  it('resolves adm-zip at 0.6.1 or later', () => {
    expect(Bun.semver.satisfies(resolvedInPluginLock('adm-zip')!, '>=0.6.1')).toBe(true);
  });

  it('resolves zod at 4.6.6 or later', () => {
    expect(Bun.semver.satisfies(resolvedInPluginLock('zod')!, '>=4.6.6')).toBe(true);
  });

  it('keeps the adm-zip override and the zod floor in the generated manifest and its generator', () => {
    const manifest = JSON.parse(read('plugin/package.json'));
    expect(manifest.overrides?.['adm-zip']).toBe('^0.6.1');
    expect(manifest.dependencies?.zod).toBe('^4.6.6');

    const generator = read('scripts/build-hooks.js');
    expect(generator).toContain("'adm-zip': '^0.6.1'");
    expect(generator).toContain("'zod': '^4.6.6'");
  });
});
