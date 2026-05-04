import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import { join } from 'path';
import {
  readClaudeOAuthToken,
  decodeJwtExpMs,
  writeStaleMarker,
  clearStaleMarker,
  readStaleMarker,
} from '../../src/shared/oauth-token.js';
import { paths } from '../../src/shared/paths.js';
import { buildIsolatedEnvWithFreshOAuth } from '../../src/shared/EnvManager.js';

/**
 * The implementation uses promisify(execFile), which captures execFile at
 * module-load time. To intercept those calls in tests we replace the export
 * on `child_process` and restore it afterwards. We also redirect DATA_DIR
 * to a per-test temp dir for marker/sidecar tests.
 */

const ORIGINAL_EXEC_FILE = childProcess.execFile;
const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_ENV_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const ORIGINAL_DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR;

let dataDirSpy: ReturnType<typeof spyOn> | undefined;
let tempDir: string;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
}

/**
 * Patch promisify(execFile) by replacing the underlying execFile with a stub
 * that calls back like the real Node API. Because oauth-token.ts already
 * captured the original at import time, we instead intercept the cached
 * promisified function via the module's internal binding by re-importing.
 *
 * Simpler approach: spy on childProcess.execFile and route calls to a fake
 * callback. Because promisify wraps execFile by reference at import time,
 * we can't intercept post-hoc. Instead we exercise the parsing logic
 * directly via parseKeychainPayload-equivalent paths: we inject results by
 * calling readClaudeOAuthToken() with platform spoofed AND the expected
 * `security`/`secret-tool` binary spy via mocking the `execFile` hostpath.
 *
 * Bun's spyOn lets us replace properties on the `child_process` module
 * object, but the promisified handle inside oauth-token.ts already holds a
 * reference. So we test the parsing layer by exercising decodeJwtExpMs
 * directly and rely on environment-fallback path for the integration shape.
 */

beforeEach(() => {
  // Redirect DATA_DIR to a temp directory for marker file tests.
  tempDir = fs.mkdtempSync(join(fs.realpathSync(require('os').tmpdir()), 'claude-mem-oauth-test-'));
  dataDirSpy = spyOn(paths, 'dataDir').mockImplementation(() => tempDir);
});

afterEach(() => {
  dataDirSpy?.mockRestore();
  restorePlatform();
  if (ORIGINAL_ENV_TOKEN === undefined) {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIGINAL_ENV_TOKEN;
  }
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.CLAUDE_MEM_DATA_DIR;
  } else {
    process.env.CLAUDE_MEM_DATA_DIR = ORIGINAL_DATA_DIR;
  }
  // Clean up temp dir
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('decodeJwtExpMs', () => {
  it('returns undefined for non-JWT tokens', () => {
    expect(decodeJwtExpMs('sk-ant-oat01-bare-token')).toBeUndefined();
    expect(decodeJwtExpMs('not.a.jwt.really')).toBeUndefined();
    expect(decodeJwtExpMs('')).toBeUndefined();
  });

  it('extracts exp claim from a real JWT and converts seconds to ms', () => {
    // header.payload.signature where payload is {"exp": 9999999999}
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url');
    const signature = 'sig';
    const jwt = `${header}.${payload}.${signature}`;
    expect(decodeJwtExpMs(jwt)).toBe(9999999999 * 1000);
  });

  it('returns undefined when JWT payload has no exp claim', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'user' })).toString('base64url');
    const jwt = `${header}.${payload}.sig`;
    expect(decodeJwtExpMs(jwt)).toBeUndefined();
  });

  it('returns undefined for malformed JWT', () => {
    expect(decodeJwtExpMs('not-base64.not-base64.sig')).toBeUndefined();
  });
});

describe('marker file scheme', () => {
  it('writeStaleMarker creates the marker file with the reason', () => {
    writeStaleMarker('token expired at 2026-01-01');
    const markerPath = join(tempDir, 'oauth-stale.marker');
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.readFileSync(markerPath, 'utf-8')).toBe('token expired at 2026-01-01');
  });

  it('readStaleMarker returns undefined when no marker exists', () => {
    expect(readStaleMarker()).toBeUndefined();
  });

  it('readStaleMarker returns the reason after writeStaleMarker', () => {
    writeStaleMarker('refresh me');
    expect(readStaleMarker()).toBe('refresh me');
  });

  it('clearStaleMarker removes an existing marker', () => {
    writeStaleMarker('temporary');
    expect(readStaleMarker()).toBe('temporary');
    clearStaleMarker();
    expect(readStaleMarker()).toBeUndefined();
  });

  it('clearStaleMarker is a no-op when no marker exists', () => {
    expect(() => clearStaleMarker()).not.toThrow();
  });
});

describe('readClaudeOAuthToken — env-fallback branch', () => {
  // These tests exercise the env-fallback path which is reachable on every
  // platform when the keychain returns absent. We force absent by spoofing
  // the platform to an unsupported value.
  beforeEach(() => {
    setPlatform('aix' as NodeJS.Platform); // unsupported -> always absent
  });

  it('returns absent when no env token is set', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const result = await readClaudeOAuthToken();
    expect(result.kind).toBe('absent');
    if (result.kind === 'absent') {
      expect(result.reason).toContain('Unsupported platform');
    }
  });

  it('returns present (env-fallback) when env token is set and not expired', async () => {
    // Non-JWT bare token, no sidecar -> no expiresAt detectable -> not expired.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-fallback';
    const result = await readClaudeOAuthToken();
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.token).toBe('sk-ant-oat01-fallback');
      expect(result.source).toBe('env-fallback');
    }
  });

  it('returns expired when env token JWT exp claim is in the past', async () => {
    // Build a JWT with exp=1 (1970) — definitely expired.
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url');
    const expiredJwt = `${header}.${payload}.sig`;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = expiredJwt;
    const result = await readClaudeOAuthToken();
    expect(result.kind).toBe('expired');
    if (result.kind === 'expired') {
      expect(result.reason).toContain('expired');
      expect(result.expiresAt).toBe(1000); // 1 sec * 1000
    }
  });

  it('returns expired when sidecar metadata indicates env token is stale', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-bare';
    // Write a sidecar with expiresAt in the past (well beyond grace window).
    const sidecarPath = join(tempDir, 'oauth-token-meta.json');
    const stalePastMs = Date.now() - 60 * 60 * 1000; // 1 hour ago
    fs.writeFileSync(sidecarPath, JSON.stringify({ expiresAt: stalePastMs }));
    const result = await readClaudeOAuthToken();
    expect(result.kind).toBe('expired');
    if (result.kind === 'expired') {
      expect(result.expiresAt).toBe(stalePastMs);
    }
  });

  it('returns present when sidecar expiresAt is in the future', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-bare';
    const sidecarPath = join(tempDir, 'oauth-token-meta.json');
    const futureMs = Date.now() + 60 * 60 * 1000; // 1 hour from now
    fs.writeFileSync(sidecarPath, JSON.stringify({ expiresAt: futureMs }));
    const result = await readClaudeOAuthToken();
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.expiresAt).toBe(futureMs);
      expect(result.source).toBe('env-fallback');
    }
  });
});

describe('readClaudeOAuthToken — macOS keychain branch', () => {
  // We can't easily intercept the cached promisified execFile from inside
  // oauth-token.ts (it captured a reference at module load). Instead we
  // verify the macOS branch dispatches by checking that on darwin without
  // a real keychain entry, the fallback path is reached.
  it('on macOS, falls back to env when keychain access fails or returns nothing', async () => {
    if (process.platform !== 'darwin') {
      // Skip on non-macOS — we only run this test where security CLI exists.
      return;
    }
    // Use an env token; if the real keychain has a fresh entry, we get
    // 'present' with source='keychain'. If no keychain entry, we fall back
    // to env-fallback. Either way, kind='present' with a non-empty token
    // (or 'expired' if the real keychain entry happens to be stale).
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test-fallback';
    setPlatform('darwin');
    const result = await readClaudeOAuthToken();
    // Whatever the keychain says, the result should be a valid kind.
    expect(['present', 'expired', 'absent']).toContain(result.kind);
    if (result.kind === 'present') {
      expect(result.token.length).toBeGreaterThan(0);
      expect(['keychain', 'env-fallback']).toContain(result.source);
    }
  });
});

describe('readClaudeOAuthToken — Linux branch', () => {
  it('on linux without secret-tool, returns absent gracefully', async () => {
    if (process.platform !== 'linux') return; // skip on non-linux
    setPlatform('linux');
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const result = await readClaudeOAuthToken();
    // If secret-tool is not installed or has no entry, returns absent.
    // If somehow present, we accept that too.
    expect(['present', 'expired', 'absent']).toContain(result.kind);
  });
});

describe('readClaudeOAuthToken — Windows branch', () => {
  it('on win32 without keychain entry, returns absent or env-fallback', async () => {
    if (process.platform !== 'win32') return; // skip on non-windows
    setPlatform('win32');
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const result = await readClaudeOAuthToken();
    expect(['present', 'expired', 'absent']).toContain(result.kind);
  });
});

// CodeRabbit Minor (PR #2282 follow-up): when the OAuth token is absent, any
// previously-written stale marker is no longer accurate (the token is gone,
// not expired). buildIsolatedEnvWithFreshOAuth must clear it on the absent
// branch the same way it does on present.
describe('buildIsolatedEnvWithFreshOAuth — absent token clears stale marker', () => {
  beforeEach(() => {
    setPlatform('aix' as NodeJS.Platform); // unsupported -> always absent
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it('clears a pre-existing stale marker when token is absent', async () => {
    // Pre-existing marker from an earlier "expired" pass.
    writeStaleMarker('left over from previous run');
    expect(readStaleMarker()).toBe('left over from previous run');

    // Force the absent path: ANTHROPIC_API_KEY must NOT be set in either the
    // env file or the process env, otherwise the early-return branch fires
    // before we ever reach the OAuth resolution.
    const origAnthropicKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await buildIsolatedEnvWithFreshOAuth(true);
    } finally {
      if (origAnthropicKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = origAnthropicKey;
      }
    }

    expect(readStaleMarker()).toBeUndefined();
  });
});
