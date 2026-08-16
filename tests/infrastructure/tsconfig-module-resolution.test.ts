import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

// TypeScript 7.0 removes the legacy "node" (node10) moduleResolution strategy,
// and TypeScript 6.x already fails with TS5107 unless ignoreDeprecations is set.
// openclaw/install.sh builds the plugin with `npx tsc`, so a removed value there
// breaks every fresh install (issue #3277).
const REMOVED_MODULE_RESOLUTIONS = ['node', 'node10'];

const TSCONFIG_PATHS = ['tsconfig.json', 'openclaw/tsconfig.json'];

describe('tsconfig moduleResolution', () => {
  for (const relPath of TSCONFIG_PATHS) {
    it(`${relPath} does not use a moduleResolution removed in TypeScript 7`, () => {
      const config = JSON.parse(readFileSync(path.join(projectRoot, relPath), 'utf-8'));
      const moduleResolution = String(config.compilerOptions?.moduleResolution ?? '').toLowerCase();
      expect(REMOVED_MODULE_RESOLUTIONS).not.toContain(moduleResolution);
    });
  }

  it('openclaw/tsconfig.json declares node types for the plugin build', () => {
    const config = JSON.parse(readFileSync(path.join(projectRoot, 'openclaw/tsconfig.json'), 'utf-8'));
    expect(config.compilerOptions?.types).toContain('node');
  });
});
