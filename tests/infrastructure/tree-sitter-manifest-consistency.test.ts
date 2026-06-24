import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

function readJson(relativePath: string): any {
  return JSON.parse(readFileSync(path.join(projectRoot, relativePath), 'utf-8'));
}

describe('Tree-sitter manifest consistency', () => {
  it('keeps the root tree-sitter override aligned with the bundled plugin manifest', () => {
    const rootPackageJson = readJson('package.json');
    const pluginPackageJson = readJson('plugin/package.json');

    expect(rootPackageJson.overrides?.['tree-sitter']).toBeDefined();
    expect(pluginPackageJson.overrides?.['tree-sitter']).toBeDefined();
    expect(rootPackageJson.overrides['tree-sitter']).toBe(
      pluginPackageJson.overrides['tree-sitter'],
    );
  });
});
