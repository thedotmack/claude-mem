import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { marketplaceDependencyDirectory } from '../src/npx-cli/commands/doctor.js';

describe('doctor marketplace dependency path', () => {
  it('checks plugin/node_modules for marketplace plugin installs', () => {
    const marketplaceDir = mkdtempSync(join(tmpdir(), 'claude-mem-doctor-marketplace-'));
    try {
      mkdirSync(join(marketplaceDir, 'plugin'), { recursive: true });
      mkdirSync(join(marketplaceDir, 'node_modules'), { recursive: true });
      writeFileSync(join(marketplaceDir, 'plugin', 'package.json'), JSON.stringify({ name: 'claude-mem' }));

      expect(marketplaceDependencyDirectory(marketplaceDir)).toBe(join(marketplaceDir, 'plugin', 'node_modules'));
    } finally {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });

  it('keeps root node_modules for legacy marketplace layouts', () => {
    const marketplaceDir = mkdtempSync(join(tmpdir(), 'claude-mem-doctor-marketplace-'));
    try {
      mkdirSync(join(marketplaceDir, 'node_modules'), { recursive: true });

      expect(marketplaceDependencyDirectory(marketplaceDir)).toBe(join(marketplaceDir, 'node_modules'));
    } finally {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });
});
