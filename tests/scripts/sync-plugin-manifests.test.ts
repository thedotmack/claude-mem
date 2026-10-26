import { describe, it, expect } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';

const projectRoot = join(import.meta.dir, '..', '..');
const marketplacePath = '.claude-plugin/marketplace.json';

const rootVersionManifests = [
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.qoder-plugin/plugin.json',
  '.grok-plugin/plugin.json',
  'dsh/package.json',
  'openclaw/openclaw.plugin.json',
  'plugin/package.json',
  'plugin/.claude-plugin/plugin.json',
  'plugin/.codex-plugin/plugin.json',
  'plugin/.qoder-plugin/plugin.json',
  'claude-mem-cursor/.cursor-plugin/plugin.json',
  'claude-mem-grok-bot/.cursor-plugin/plugin.json',
];

describe('sync-plugin-manifests', () => {
  it('writes the root version to every shipped manifest', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'cmem-sync-manifests-'));

    try {
      const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
      packageJson.version = '9.9.9';
      writeFileSync(
        join(fixtureRoot, 'package.json'),
        `${JSON.stringify(packageJson, null, 2)}\n`,
      );

      mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true });
      cpSync(
        join(projectRoot, 'scripts', 'sync-plugin-manifests.js'),
        join(fixtureRoot, 'scripts', 'sync-plugin-manifests.js'),
      );

      for (const manifestPath of [...rootVersionManifests, marketplacePath]) {
        const destination = join(fixtureRoot, manifestPath);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(projectRoot, manifestPath), destination);
      }

      const result = spawnSync(
        process.execPath,
        [join(fixtureRoot, 'scripts', 'sync-plugin-manifests.js')],
        { cwd: fixtureRoot, encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);

      for (const manifestPath of rootVersionManifests) {
        const manifest = JSON.parse(readFileSync(join(fixtureRoot, manifestPath), 'utf8'));
        expect(manifest.version, manifestPath).toBe('9.9.9');
      }

      const marketplace = JSON.parse(
        readFileSync(join(fixtureRoot, marketplacePath), 'utf8'),
      );
      const claudeMem = marketplace.plugins.find((plugin: any) => plugin.name === 'claude-mem');
      const cowork = marketplace.plugins.find((plugin: any) => plugin.name === 'claude-mem-cowork');
      expect(claudeMem?.version).toBe('9.9.9');
      expect(cowork?.version).toBe('0.1.4');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
