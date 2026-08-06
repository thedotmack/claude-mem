import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveCloudConnection,
  validateCloudConnection,
} from '../src/npx-cli/commands/cloud.js';

const temporaryDirectories: string[] = [];

function temporarySettingsPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mem-cloud-connect-'));
  temporaryDirectories.push(directory);
  return join(directory, 'settings.json');
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

const valid = {
  userId: '123e4567-e89b-42d3-a456-426614174000',
  hubUrl: 'https://sync.cmem.ai/',
  syncToken: `cm_pro_${'a'.repeat(32)}`,
  workerUrl: 'https://cmem.ai/api/worker/v1/',
  workerKey: `cmem_worker_${'A'.repeat(43)}`,
};

describe('cloud connect', () => {
  test('writes secrets atomically at mode 0600 and preserves unrelated flat settings', () => {
    const path = temporarySettingsPath();
    writeFileSync(path, JSON.stringify({ CLAUDE_MEM_WORKER_PORT: 39999 }), { mode: 0o644 });

    saveCloudConnection(valid, path);

    const settings = JSON.parse(readFileSync(path, 'utf-8'));
    expect(settings.CLAUDE_MEM_WORKER_PORT).toBe(39999);
    expect(settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN).toBe(valid.syncToken);
    expect(settings.CLAUDE_MEM_OPENROUTER_API_KEY).toBe(valid.workerKey);
    expect(settings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL).toBe('https://sync.cmem.ai');
    expect(settings.CLAUDE_MEM_OPENROUTER_BASE_URL).toBe('https://cmem.ai/api/worker/v1');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('preserves the legacy env-nested settings shape', () => {
    const path = temporarySettingsPath();
    writeFileSync(path, JSON.stringify({ theme: 'dark', env: { OTHER: 'kept' } }));

    saveCloudConnection({
      userId: valid.userId,
      hubUrl: valid.hubUrl,
      syncToken: valid.syncToken,
    }, path);

    const settings = JSON.parse(readFileSync(path, 'utf-8'));
    expect(settings.theme).toBe('dark');
    expect(settings.env.OTHER).toBe('kept');
    expect(settings.env.CLAUDE_MEM_CLOUD_SYNC_TOKEN).toBe(valid.syncToken);
    expect(settings.CLAUDE_MEM_OPENROUTER_API_KEY).toBeUndefined();
  });

  test('rejects incomplete worker settings and unsafe URLs', () => {
    expect(() => validateCloudConnection({
      userId: valid.userId,
      hubUrl: valid.hubUrl,
      syncToken: valid.syncToken,
      workerUrl: valid.workerUrl,
    })).toThrow('configured together');

    expect(() => validateCloudConnection({
      ...valid,
      hubUrl: 'http://sync.cmem.ai',
    })).toThrow('must use https');

    expect(() => validateCloudConnection({
      ...valid,
      workerUrl: 'https://cmem.ai/api/worker/v1/anything',
    })).toThrow('must end at /api/worker/v1');
  });
});
