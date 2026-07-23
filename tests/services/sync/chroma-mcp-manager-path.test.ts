import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import * as realOs from 'node:os';
import path from 'node:path';
import * as realClientSdk from '@modelcontextprotocol/sdk/client/index.js';
import * as realStdioSdk from '@modelcontextprotocol/sdk/client/stdio.js';
import * as realLogger from '../../../src/utils/logger.js';
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realPaths from '../../../src/shared/paths.js';
import * as realEnvSanitizer from '../../../src/supervisor/env-sanitizer.js';
import * as realSupervisor from '../../../src/supervisor/index.ts';

const realClientSdkSnapshot = { ...realClientSdk };
const realStdioSdkSnapshot = { ...realStdioSdk };
const realLoggerSnapshot = { ...realLogger };
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realPathsSnapshot = { ...realPaths };
const realEnvSanitizerSnapshot = { ...realEnvSanitizer };
const realSupervisorSnapshot = { ...realSupervisor };
const realProcessPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const existingDirs = new Set<string>();

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {},
}));

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {},
}));

mock.module('../../../src/utils/logger.js', () => ({
  logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, failure: () => {} },
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: { get: () => '', getInt: () => 0, loadFromFile: () => ({}) },
}));

mock.module('../../../src/shared/paths.js', () => ({
  USER_SETTINGS_PATH: '/tmp/fake-settings.json',
  paths: { chroma: () => '/tmp/fake-chroma', combinedCerts: () => '/tmp/fake-certs.pem' },
}));

mock.module('../../../src/supervisor/env-sanitizer.js', () => ({
  sanitizeEnv: (env: NodeJS.ProcessEnv) => env,
}));

mock.module('../../../src/supervisor/index.ts', () => ({
  getSupervisor: () => ({ assertCanSpawn: () => {}, registerProcess: () => {}, unregisterProcess: () => {} }),
}));

import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

type ChromaPathInternals = {
  getUvxPreflightEnv: () => Record<string, string>;
};

const getUvxPreflightEnv = (ChromaMcpManager as unknown as ChromaPathInternals).getUvxPreflightEnv;
const originalPath = process.env.PATH;
const originalOverride = process.env.CLAUDE_MEM_CHROMA_UVX_PATH;
const fsRuntime = require('node:fs');
const originalExistsSync = fsRuntime.existsSync;
fsRuntime.existsSync = (candidate: string) => existingDirs.has(candidate);

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function setPath(value: string): void {
  delete process.env.Path;
  delete process.env.CLAUDE_MEM_CHROMA_UVX_PATH;
  process.env.PATH = value;
}

function childPath(): string[] {
  const sep = process.platform === 'win32' ? ';' : ':';
  return getUvxPreflightEnv().PATH.split(sep);
}

beforeEach(() => {
  existingDirs.clear();
  setPlatform('darwin');
});

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalOverride === undefined) delete process.env.CLAUDE_MEM_CHROMA_UVX_PATH;
  else process.env.CLAUDE_MEM_CHROMA_UVX_PATH = originalOverride;
  if (realProcessPlatform) {
    Object.defineProperty(process, 'platform', realProcessPlatform);
  }
  fsRuntime.existsSync = originalExistsSync;
  mock.module('@modelcontextprotocol/sdk/client/index.js', () => realClientSdkSnapshot);
  mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => realStdioSdkSnapshot);
  mock.module('../../../src/utils/logger.js', () => realLoggerSnapshot);
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/paths.js', () => realPathsSnapshot);
  mock.module('../../../src/supervisor/env-sanitizer.js', () => realEnvSanitizerSnapshot);
  mock.module('../../../src/supervisor/index.ts', () => realSupervisorSnapshot);
  existingDirs.clear();
});

describe('ChromaMcpManager child PATH Homebrew coverage (#3271)', () => {
  it('prepends /opt/homebrew/bin on darwin when present and missing from PATH', () => {
    setPath('/usr/bin:/bin');
    existingDirs.add('/opt/homebrew/bin');

    expect(childPath()).toEqual(['/opt/homebrew/bin', '/usr/bin', '/bin']);
  });

  it('prepends /usr/local/bin on darwin when present and missing from PATH', () => {
    setPath('/usr/bin:/bin');
    existingDirs.add('/usr/local/bin');

    expect(childPath()).toEqual(['/usr/local/bin', '/usr/bin', '/bin']);
  });

  it('adds no Homebrew PATH entries when the dirs do not exist', () => {
    setPath('/usr/bin:/bin');

    expect(childPath()).toEqual(['/usr/bin', '/bin']);
  });

  it('does not duplicate an existing Homebrew PATH entry', () => {
    setPath('/opt/homebrew/bin:/usr/bin');
    existingDirs.add('/opt/homebrew/bin');

    expect(childPath()).toEqual(['/opt/homebrew/bin', '/usr/bin']);
  });

  it('preserves existing uv default bin handling on win32', () => {
    setPlatform('win32');
    setPath('C:\\Windows\\System32;C:\\Windows');
    existingDirs.add(path.join(realOs.homedir(), '.local', 'bin'));
    existingDirs.add(path.join(realOs.homedir(), '.cargo', 'bin'));

    expect(childPath()).toEqual([
      path.join(realOs.homedir(), '.local', 'bin'),
      path.join(realOs.homedir(), '.cargo', 'bin'),
      'C:\\Windows\\System32',
      'C:\\Windows',
    ]);
  });

  it('does not add Homebrew PATH entries on linux', () => {
    setPlatform('linux');
    setPath('/usr/bin:/bin');
    existingDirs.add('/opt/homebrew/bin');
    existingDirs.add('/usr/local/bin');

    expect(childPath()).toEqual(['/usr/bin', '/bin']);
  });
});
