import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

const VERSION_MARKER_PATH = join(process.cwd(), '.install-version');

test('version marker - new JSON format', () => {
  const marker = {
    packageVersion: '6.3.2',
    nodeVersion: 'v22.21.1',
    installedAt: new Date().toISOString()
  };

  writeFileSync(VERSION_MARKER_PATH, JSON.stringify(marker, null, 2));
  const content = JSON.parse(readFileSync(VERSION_MARKER_PATH, 'utf-8'));

  assert.strictEqual(content.packageVersion, '6.3.2');
  assert.strictEqual(content.nodeVersion, 'v22.21.1');
  assert.ok(content.installedAt);

  unlinkSync(VERSION_MARKER_PATH);
});

test('version marker - backward compatibility with old format', () => {
  // Old format: plain text version string
  writeFileSync(VERSION_MARKER_PATH, '6.3.2');
  const content = readFileSync(VERSION_MARKER_PATH, 'utf-8').trim();

  // Should be able to parse old format
  let marker;
  try {
    marker = JSON.parse(content);
  } catch {
    // Old format - create compatible object
    marker = {
      packageVersion: content,
      nodeVersion: null,
      installedAt: null
    };
  }

  assert.strictEqual(marker.packageVersion, '6.3.2');
  assert.strictEqual(marker.nodeVersion, null);

  unlinkSync(VERSION_MARKER_PATH);
});
