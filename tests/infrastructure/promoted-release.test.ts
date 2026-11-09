import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { compareVersionsDescending } from '../../src/shared/worker-utils.js';

// releases/promoted-release.json is the owner's release switch: claude-mem's own
// updater reads it from main to learn which version it may move installs to.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const promotedReleaseRelativePath = 'releases/promoted-release.json';

function readJsonFileFromProjectRoot(relativePathFromProjectRoot: string) {
  return JSON.parse(readFileSync(path.join(projectRoot, relativePathFromProjectRoot), 'utf-8'));
}

describe('Promoted release file', () => {
  it(`should parse ${promotedReleaseRelativePath} with schemaVersion 1`, () => {
    expect(existsSync(path.join(projectRoot, promotedReleaseRelativePath))).toBe(true);

    const promotedRelease = readJsonFileFromProjectRoot(promotedReleaseRelativePath);
    expect(promotedRelease.schemaVersion).toBe(1);
  });

  it('should have exactly the keys schemaVersion and promotedVersion', () => {
    // No `version` key: it would join version-bump's `"version": "<OLD>"`
    // coverage grep, and promotion is never part of a version bump.
    const promotedRelease = readJsonFileFromProjectRoot(promotedReleaseRelativePath);
    expect(Object.keys(promotedRelease).sort()).toEqual(['promotedVersion', 'schemaVersion']);
  });

  it('should name an exact release version', () => {
    const promotedRelease = readJsonFileFromProjectRoot(promotedReleaseRelativePath);
    expect(promotedRelease.promotedVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('should not promote a version newer than package.json', () => {
    // A release cannot be promoted before it is built.
    const promotedVersion = readJsonFileFromProjectRoot(promotedReleaseRelativePath).promotedVersion;
    const packageVersion = readJsonFileFromProjectRoot('package.json').version;

    // compareVersionsDescending(a, b) is negative when a is newer than b.
    expect(compareVersionsDescending(promotedVersion, packageVersion)).toBeGreaterThanOrEqual(0);
  });
});
