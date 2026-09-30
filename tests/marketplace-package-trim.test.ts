import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeTrimmedMarketplacePackageJson } from '../src/npx-cli/commands/install.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

describe('writeTrimmedMarketplacePackageJson', () => {
  let workDir: string;
  let packageRoot: string;
  let marketplaceDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'cmem-trim-'));
    packageRoot = path.join(workDir, 'pkg');
    marketplaceDir = path.join(workDir, 'marketplace');
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(marketplaceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeRootPackageJson(pkg: Record<string, unknown>): void {
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify(pkg, null, 2));
  }

  function readMarketplacePackageJson(): any {
    return JSON.parse(readFileSync(path.join(marketplaceDir, 'package.json'), 'utf-8'));
  }

  it('strips devDependencies and trustedDependencies but keeps runtime deps', () => {
    writeRootPackageJson({
      name: 'claude-mem',
      dependencies: { 'better-auth': '^1.6.16', '@better-auth/api-key': '^1.6.16' },
      devDependencies: {
        '@derekstride/tree-sitter-sql': '^0.3.11',
        '@tree-sitter-grammars/tree-sitter-lua': '^0.4.1',
      },
      trustedDependencies: ['tree-sitter-c'],
    });

    writeTrimmedMarketplacePackageJson(packageRoot, marketplaceDir);

    const trimmed = readMarketplacePackageJson();
    expect(trimmed.devDependencies).toBeUndefined();
    expect(trimmed.trustedDependencies).toBeUndefined();
    expect(trimmed.dependencies).toEqual({
      'better-auth': '^1.6.16',
      '@better-auth/api-key': '^1.6.16',
    });
  });

  it('leaves no conflicting tree-sitter grammar in the real root package.json output', () => {
    const realRoot = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    writeRootPackageJson(realRoot);

    writeTrimmedMarketplacePackageJson(packageRoot, marketplaceDir);

    const trimmed = readMarketplacePackageJson();
    const allDeps = JSON.stringify({ ...trimmed.dependencies, ...trimmed.devDependencies });
    expect(allDeps).not.toContain('tree-sitter');
    expect(trimmed.dependencies['better-auth']).toBeDefined();
    expect(trimmed.dependencies['@better-auth/api-key']).toBeDefined();
  });

  it('does nothing when the source package.json is absent', () => {
    expect(() => writeTrimmedMarketplacePackageJson(packageRoot, marketplaceDir)).not.toThrow();
  });
});
