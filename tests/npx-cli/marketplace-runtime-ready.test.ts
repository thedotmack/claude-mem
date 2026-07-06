import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isMarketplaceRuntimeReady } from '../../src/npx-cli/commands/install.js';

describe('marketplace runtime readiness', () => {
  it('requires zod/v3 where hook runtime resolves plugin dependencies', () => {
    const marketplaceDir = mkdtempSync(join(tmpdir(), 'claude-mem-marketplace-'));
    try {
      mkdirSync(join(marketplaceDir, 'plugin', 'scripts'), { recursive: true });
      writeFileSync(join(marketplaceDir, 'package.json'), JSON.stringify({ version: '13.4.0' }));
      writeFileSync(join(marketplaceDir, 'plugin', 'scripts', 'worker-service.cjs'), '');
      const runtimeReadyPaths = [
        join(marketplaceDir, 'plugin', 'scripts', 'worker-service.cjs'),
        join(marketplaceDir, 'plugin', 'node_modules', 'zod', 'package.json'),
        join(marketplaceDir, 'plugin', 'node_modules', 'zod', 'v3'),
      ];

      expect(isMarketplaceRuntimeReady(runtimeReadyPaths)).toBe(false);

      mkdirSync(join(marketplaceDir, 'node_modules', 'zod', 'v3'), { recursive: true });
      writeFileSync(join(marketplaceDir, 'node_modules', 'zod', 'package.json'), JSON.stringify({ version: '4.4.3' }));

      expect(isMarketplaceRuntimeReady(runtimeReadyPaths)).toBe(false);

      mkdirSync(join(marketplaceDir, 'plugin', 'node_modules', 'zod', 'v3'), { recursive: true });
      writeFileSync(join(marketplaceDir, 'plugin', 'node_modules', 'zod', 'package.json'), JSON.stringify({ version: '4.4.3' }));

      expect(isMarketplaceRuntimeReady(runtimeReadyPaths)).toBe(true);
    } finally {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });
});
