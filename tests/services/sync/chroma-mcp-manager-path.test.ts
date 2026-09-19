import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
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

  it('forces UTF-8 on the Python child stdio so locale code pages cannot corrupt JSON-RPC', () => {
    const env = getUvxPreflightEnv();
    expect(env.PYTHONUTF8).toBe('1');
    expect(env.PYTHONIOENCODING).toBe('utf-8');
  });
});

describe('ChromaMcpManager uv link mode on Windows (#4108)', () => {
  const savedLinkMode = process.env.UV_LINK_MODE;
  const savedLinkModeLower = process.env.uv_link_mode;

  beforeEach(() => {
    delete process.env.UV_LINK_MODE;
    delete process.env.uv_link_mode;
  });

  afterAll(() => {
    if (savedLinkMode === undefined) delete process.env.UV_LINK_MODE;
    else process.env.UV_LINK_MODE = savedLinkMode;
    if (savedLinkModeLower === undefined) delete process.env.uv_link_mode;
    else process.env.uv_link_mode = savedLinkModeLower;
  });

  it('sets UV_LINK_MODE=copy on win32 so the NTFS hardlink ceiling cannot stall installs', () => {
    setPlatform('win32');
    setPath('C:\\Windows\\System32');

    expect(getUvxPreflightEnv().UV_LINK_MODE).toBe('copy');
  });

  it('does not set UV_LINK_MODE on darwin', () => {
    setPlatform('darwin');
    setPath('/usr/bin:/bin');

    expect(getUvxPreflightEnv().UV_LINK_MODE).toBeUndefined();
  });

  it('does not set UV_LINK_MODE on linux', () => {
    setPlatform('linux');
    setPath('/usr/bin:/bin');

    expect(getUvxPreflightEnv().UV_LINK_MODE).toBeUndefined();
  });

  it('preserves an explicit UV_LINK_MODE on win32', () => {
    setPlatform('win32');
    setPath('C:\\Windows\\System32');
    process.env.UV_LINK_MODE = 'symlink';

    expect(getUvxPreflightEnv().UV_LINK_MODE).toBe('symlink');
  });

  it('preserves a lowercase uv_link_mode on win32 without adding a duplicate key', () => {
    // Windows env names are case-insensitive, so a lowercase override must count
    // as set; otherwise the child gets both keys and uvx ignores the user's.
    setPlatform('win32');
    setPath('C:\\Windows\\System32');
    process.env.uv_link_mode = 'symlink';

    const env = getUvxPreflightEnv();
    expect(env.uv_link_mode).toBe('symlink');
    expect(env.UV_LINK_MODE).toBeUndefined();
  });
});

describe('ChromaMcpManager uv build scratch sweep (#4108)', () => {
  const nodeFs = require('node:fs');
  const sweepUvBuildsScratch = (ChromaMcpManager as unknown as {
    sweepUvBuildsScratch: (env: Record<string, string>) => void;
  }).sweepUvBuildsScratch;
  let cacheRoot = '';
  let buildsDir = '';

  function makeScratch(name: string, ageMs: number): void {
    const dir = path.join(buildsDir, name);
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(path.join(dir, 'wheel'), 'x');
    const when = new Date(Date.now() - ageMs);
    nodeFs.utimesSync(dir, when, when);
  }

  function remaining(): string[] {
    return (nodeFs.readdirSync(buildsDir) as string[]).sort();
  }

  beforeEach(() => {
    cacheRoot = nodeFs.mkdtempSync(path.join(realOs.tmpdir(), 'claude-mem-uv-cache-'));
    buildsDir = path.join(cacheRoot, 'builds-v0');
    nodeFs.mkdirSync(buildsDir, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  it('resolves builds-v0 under UV_CACHE_DIR when set', () => {
    expect(ChromaMcpManager.resolveUvBuildsScratchDir({ UV_CACHE_DIR: cacheRoot }, 'linux', '/home/u'))
      .toBe(buildsDir);
  });

  it('resolves builds-v0 under LOCALAPPDATA on win32', () => {
    expect(
      ChromaMcpManager.resolveUvBuildsScratchDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u')
    ).toBe(path.join('C:\\Users\\u\\AppData\\Local', 'uv', 'cache', 'builds-v0'));
  });

  it('removes abandoned .tmp scratch but keeps cached builds and any recent scratch', () => {
    makeScratch('.tmpABANDONED', 25 * 60 * 60_000); // > 24h: no live build lasts a day
    makeScratch('.tmpBUILDING', 10 * 60_000); // minutes old: could be a live build
    makeScratch('wheels-v1', 25 * 60 * 60_000); // real cached build, not scratch

    sweepUvBuildsScratch({ UV_CACHE_DIR: cacheRoot });

    const left = remaining();
    expect(left).not.toContain('.tmpABANDONED');
    expect(left).toContain('.tmpBUILDING');
    expect(left).toContain('wheels-v1');
  });

  it('is a no-op when the builds dir does not exist', () => {
    expect(() =>
      sweepUvBuildsScratch({ UV_CACHE_DIR: path.join(cacheRoot, 'does-not-exist') })
    ).not.toThrow();
  });
});
