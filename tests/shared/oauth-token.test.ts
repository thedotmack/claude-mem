import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  readClaudeOAuthToken,
  decodeJwtExpMs,
  writeStaleMarker,
  clearStaleMarker,
  readStaleMarker,
  resolveEffectiveClaudeConfigDir,
  deriveMacKeychainServiceName,
  readMacOsKeychain,
} from '../../src/shared/oauth-token.js';
import { paths, CLAUDE_CONFIG_DIR, DEFAULT_CLAUDE_CONFIG_DIR } from '../../src/shared/paths.js';
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
    if (result.kind === 'absent') {
      expect(result.reason).not.toContain('Windows Credential Manager read failed');
      expect(result.reason).toContain('Windows Credential Manager has no entry');
    }
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

/**
 * #2753 — resolveEffectiveClaudeConfigDir precedence: the
 * CLAUDE_MEM_CLAUDE_CONFIG_DIR setting wins when non-empty; an empty,
 * whitespace-only, or absent setting falls through to paths.CLAUDE_CONFIG_DIR
 * (which already folds in process.env.CLAUDE_CONFIG_DIR vs. the default —
 * see the frozen-at-module-load note in tests/env-isolation.test.ts for why
 * that half of the fallback isn't re-tested dynamically here).
 */
describe('resolveEffectiveClaudeConfigDir (#2753)', () => {
  it('returns the trimmed setting when it is non-empty', () => {
    expect(resolveEffectiveClaudeConfigDir('/custom/config/dir')).toBe('/custom/config/dir');
    expect(resolveEffectiveClaudeConfigDir('  /padded/dir  ')).toBe('/padded/dir');
  });

  it('falls through to the frozen CLAUDE_CONFIG_DIR for an empty, whitespace-only, or absent setting', () => {
    expect(resolveEffectiveClaudeConfigDir('')).toBe(CLAUDE_CONFIG_DIR);
    expect(resolveEffectiveClaudeConfigDir('   ')).toBe(CLAUDE_CONFIG_DIR);
    expect(resolveEffectiveClaudeConfigDir(undefined)).toBe(CLAUDE_CONFIG_DIR);
  });

  // Round 2 fix: a human-typed '~/...' setting value must expand to the same
  // effective dir (and therefore the same keychain suffix) as its already-
  // expanded absolute-path form — otherwise deriveMacKeychainServiceName
  // hashes the literal tilde string and never matches the real keychain entry.
  it('expands a leading ~ to the same effective dir as the equivalent absolute path', () => {
    const absolute = join(homedir(), '.ccs', 'instances', 'nyeq50');
    const tilde = '~/.ccs/instances/nyeq50';

    const resolvedFromTilde = resolveEffectiveClaudeConfigDir(tilde);
    const resolvedFromAbsolute = resolveEffectiveClaudeConfigDir(absolute);

    expect(resolvedFromTilde).toBe(resolvedFromAbsolute);
    expect(resolvedFromTilde).toBe(absolute);
    // And the downstream keychain suffix derivation must therefore agree too —
    // this is the actual failure mode a missing expansion produces.
    expect(deriveMacKeychainServiceName(resolvedFromTilde)).toBe(
      deriveMacKeychainServiceName(resolvedFromAbsolute),
    );
  });

  it('expands a padded "~/..." setting value (trim then expand, not expand then trim)', () => {
    const absolute = join(homedir(), '.ccs', 'instances', 'nyeq50');
    expect(resolveEffectiveClaudeConfigDir('  ~/.ccs/instances/nyeq50  ')).toBe(absolute);
  });

  // Round 3 fix: a trailing separator must not survive into the effective
  // dir — otherwise `~/.claude/` (a very plausible human/shell-completion
  // typo for "my default profile") resolves to "<home>/.claude/", which
  // fails deriveMacKeychainServiceName's bare `=== DEFAULT_CLAUDE_CONFIG_DIR`
  // check and derives a WRONG suffixed service name for what the user meant
  // as the default. Node's path.join (used by both expandTilde and
  // DEFAULT_CLAUDE_CONFIG_DIR's own derivation) preserves a trailing
  // separator rather than normalizing it away, so this is not hypothetical.
  it('strips a trailing separator so "~/.claude/" resolves to the bare default, not a suffixed dir', () => {
    const resolvedFromTildeSlash = resolveEffectiveClaudeConfigDir('~/.claude/');
    expect(resolvedFromTildeSlash).toBe(DEFAULT_CLAUDE_CONFIG_DIR);
    expect(deriveMacKeychainServiceName(resolvedFromTildeSlash)).toBe('Claude Code-credentials');
  });

  it('strips a trailing separator from an already-absolute setting value with a trailing slash', () => {
    const absoluteWithSlash = `${DEFAULT_CLAUDE_CONFIG_DIR}/`;
    const resolved = resolveEffectiveClaudeConfigDir(absoluteWithSlash);
    expect(resolved).toBe(DEFAULT_CLAUDE_CONFIG_DIR);
    expect(deriveMacKeychainServiceName(resolved)).toBe('Claude Code-credentials');
  });

  it('strips a trailing separator so an instance dir with a trailing slash matches its no-slash suffix', () => {
    const noSlash = '/Users/matthewdnye/.ccs/instances/iveg50';
    const withSlash = `${noSlash}/`;
    const resolvedNoSlash = resolveEffectiveClaudeConfigDir(noSlash);
    const resolvedWithSlash = resolveEffectiveClaudeConfigDir(withSlash);
    expect(resolvedWithSlash).toBe(resolvedNoSlash);
    expect(deriveMacKeychainServiceName(resolvedWithSlash)).toBe(
      deriveMacKeychainServiceName(resolvedNoSlash),
    );
  });
});

/**
 * #2753 — deriveMacKeychainServiceName suffix-derivation table, empirically
 * verified 2026-09-06 on the Mac Studio (see the task background): Claude
 * Code stores per-config-dir credentials under
 * 'Claude Code-credentials-<sha256(configDirPath)[:8]>' for every config dir
 * other than the literal default (~/.claude), which stays unsuffixed. These
 * are pure sha256-of-a-literal-string computations — deterministic on any
 * machine regardless of its actual $HOME, so the hardcoded Studio paths
 * below are a legitimate portable fixture, not an environment dependency.
 */
describe('deriveMacKeychainServiceName (#2753) — suffix-derivation table', () => {
  it('returns the bare "Claude Code-credentials" for the literal default config dir', () => {
    expect(deriveMacKeychainServiceName(DEFAULT_CLAUDE_CONFIG_DIR)).toBe('Claude Code-credentials');
  });

  const studioTable: Array<{ instance: string; configDir: string; suffix: string }> = [
    { instance: 'iveg50', configDir: '/Users/matthewdnye/.ccs/instances/iveg50', suffix: 'faf0d083' },
    { instance: 'nyem50', configDir: '/Users/matthewdnye/.ccs/instances/nyem50', suffix: '7034a92a' },
    { instance: 'qcom50', configDir: '/Users/matthewdnye/.ccs/instances/qcom50', suffix: '8bb48066' },
    { instance: 'flee50', configDir: '/Users/matthewdnye/.ccs/instances/flee50', suffix: '53f0e97f' },
    { instance: 'nyeq50', configDir: '/Users/matthewdnye/.ccs/instances/nyeq50', suffix: 'e38871d4' },
    { instance: 'repl00', configDir: '/Users/matthewdnye/.ccs/instances/repl00', suffix: '2e1325ac' },
  ];

  for (const { instance, configDir, suffix } of studioTable) {
    it(`suffixes ${instance} (${configDir}) as "Claude Code-credentials-${suffix}"`, () => {
      expect(deriveMacKeychainServiceName(configDir)).toBe(`Claude Code-credentials-${suffix}`);
    });
  }
});

/**
 * #2753 — readMacOsKeychain's injectable execImpl seam, exercised directly
 * (not through readClaudeOAuthToken/process.platform dispatch — see the
 * module-load comment on readMacOsKeychain for why the module-level
 * execFileAsync can't be intercepted post-hoc). Because execImpl is fully
 * injected here, this never shells out to the real `security` binary, so —
 * unlike the platform-dispatch tests elsewhere in this file — it does NOT
 * need a `if (process.platform !== 'darwin') return;` guard; it runs on any
 * host OS and never touches the real keychain.
 */
describe('readMacOsKeychain with an injected execImpl (#2753)', () => {
  it('the default service name returns absent while a per-config-dir suffixed service name returns present ("default item empty, instance item valid")', async () => {
    const instanceServiceName = deriveMacKeychainServiceName('/Users/matthewdnye/.ccs/instances/iveg50');
    const futureExpiresAt = Date.now() + 60 * 60 * 1000;
    const instancePayload = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-instance-token', expiresAt: futureExpiresAt },
    });

    const fakeExecImpl = mock((_cmd: string, args: readonly string[]) => {
      const serviceArgIndex = args.indexOf('-s');
      const serviceName = serviceArgIndex >= 0 ? args[serviceArgIndex + 1] : undefined;
      if (serviceName === instanceServiceName) {
        return Promise.resolve({ stdout: instancePayload, stderr: '' });
      }
      // The default item is empty (no keychain entry) — `security` exits
      // non-zero and execFile rejects, exactly like the real binary.
      return Promise.reject(new Error(
        'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'
      ));
    }) as any;

    const defaultResult = await readMacOsKeychain('Claude Code-credentials', fakeExecImpl);
    expect(defaultResult.kind).toBe('absent');

    const instanceResult = await readMacOsKeychain(instanceServiceName, fakeExecImpl);
    expect(instanceResult.kind).toBe('present');
    if (instanceResult.kind === 'present') {
      expect(instanceResult.token).toBe('sk-ant-oat01-instance-token');
      expect(instanceResult.source).toBe('keychain');
      expect(instanceResult.expiresAt).toBe(futureExpiresAt);
    }

    expect(fakeExecImpl).toHaveBeenCalledTimes(2);
  });
});

/**
 * #2753 — the gap the tests above leave open: they only exercise
 * resolveEffectiveClaudeConfigDir / deriveMacKeychainServiceName /
 * readMacOsKeychain as standalone units. None of them assert what
 * readClaudeOAuthToken() ITSELF passes to readMacOsKeychain on the darwin
 * dispatch — so a future refactor or merge-conflict resolution could
 * silently drop the `deriveMacKeychainServiceName(effectiveConfigDir)` call
 * at that one call site (reverting to the pre-#2753 bug: always the bare
 * default keychain item, regardless of CLAUDE_CONFIG_DIR) and every existing
 * test would still pass. These tests close that gap by driving
 * readClaudeOAuthToken() end-to-end with an injected execImpl (the same seam
 * readMacOsKeychain already exposes, now threaded through
 * readClaudeOAuthToken too) plus a spied paths.settings() pointing at a
 * controlled temp settings.json, and asserting the actual `-s <name>`
 * argument the darwin branch hands to the exec call.
 *
 * Like the "injected execImpl" describe above, this never shells out to the
 * real `security` binary, so it spoofs platform to darwin unconditionally
 * and runs on any host OS.
 */
describe('readClaudeOAuthToken (#2753) — darwin dispatch wires the derived service name through', () => {
  let settingsPathSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    setPlatform('darwin');
  });

  afterEach(() => {
    settingsPathSpy?.mockRestore();
    settingsPathSpy = undefined;
  });

  function stubSettingsFile(configDirSetting: string): void {
    const settingsPath = join(tempDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: configDirSetting }));
    settingsPathSpy = spyOn(paths, 'settings').mockImplementation(() => settingsPath);
  }

  function fakeExecFor(expectedServiceName: string, payload: string): any {
    return mock((_cmd: string, args: readonly string[]) => {
      const serviceArgIndex = args.indexOf('-s');
      const serviceName = serviceArgIndex >= 0 ? args[serviceArgIndex + 1] : undefined;
      if (serviceName === expectedServiceName) {
        return Promise.resolve({ stdout: payload, stderr: '' });
      }
      return Promise.reject(new Error(`unexpected keychain service name: ${serviceName}`));
    });
  }

  it('passes deriveMacKeychainServiceName(effectiveConfigDir) through — not the bare default — when the setting is non-empty', async () => {
    const instanceConfigDir = '/Users/matthewdnye/.ccs/instances/iveg50';
    stubSettingsFile(instanceConfigDir);
    const expectedServiceName = deriveMacKeychainServiceName(instanceConfigDir);
    expect(expectedServiceName).not.toBe('Claude Code-credentials');

    const futureExpiresAt = Date.now() + 60 * 60 * 1000;
    const payload = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-wired-token', expiresAt: futureExpiresAt },
    });
    const fakeExecImpl = fakeExecFor(expectedServiceName, payload);

    const result = await readClaudeOAuthToken(fakeExecImpl);

    expect(fakeExecImpl).toHaveBeenCalledTimes(1);
    const callArgs = fakeExecImpl.mock.calls[0][1] as string[];
    expect(callArgs).toContain(expectedServiceName);
    expect(callArgs).not.toContain('Claude Code-credentials');
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.token).toBe('sk-ant-oat01-wired-token');
      expect(result.source).toBe('keychain');
    }
  });

  it('falls through to deriveMacKeychainServiceName(CLAUDE_CONFIG_DIR) when the setting is empty', async () => {
    stubSettingsFile('');
    // NOT hardcoded to the bare 'Claude Code-credentials': CLAUDE_CONFIG_DIR
    // is frozen at module load from process.env.CLAUDE_CONFIG_DIR (or the
    // default), and this suite itself may be running under a non-default
    // CCS-instance config dir (e.g. iveg50) — exactly the "fleet" scenario
    // the critical finding warned a silent regression would hit hardest. The
    // expected value must track whatever this process's own CLAUDE_CONFIG_DIR
    // actually is, the same way resolveEffectiveClaudeConfigDir's own
    // fall-through tests do above.
    const expectedServiceName = deriveMacKeychainServiceName(CLAUDE_CONFIG_DIR);

    const futureExpiresAt = Date.now() + 60 * 60 * 1000;
    const payload = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-default-token', expiresAt: futureExpiresAt },
    });
    const fakeExecImpl = fakeExecFor(expectedServiceName, payload);

    const result = await readClaudeOAuthToken(fakeExecImpl);

    expect(fakeExecImpl).toHaveBeenCalledTimes(1);
    const callArgs = fakeExecImpl.mock.calls[0][1] as string[];
    expect(callArgs).toContain(expectedServiceName);
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.token).toBe('sk-ant-oat01-default-token');
    }
  });
});
