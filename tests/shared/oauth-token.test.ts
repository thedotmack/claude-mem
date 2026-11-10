import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import {
  readClaudeOAuthToken,
  decodeJwtExpMs,
  writeStaleMarker,
  clearStaleMarker,
  readStaleMarker,
  resolveEffectiveClaudeConfigDir,
  resolveClaudeCredentialProfile,
  deriveMacKeychainServiceName,
  readMacOsKeychain,
  readClaudeCredentialsFile,
  sanitizeMacOsKeychainAccount,
} from '../../src/shared/oauth-token.js';
import { paths, CLAUDE_CONFIG_DIR, DEFAULT_CLAUDE_CONFIG_DIR } from '../../src/shared/paths.js';
import { buildIsolatedEnvWithFreshOAuth } from '../../src/shared/EnvManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_ENV_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const ORIGINAL_DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR;

let dataDirSpy: ReturnType<typeof spyOn> | undefined;
let settingsSpy: ReturnType<typeof spyOn> | undefined;
let tempDir: string;

/**
 * The credential profile dir every test resolves to: empty unless a test
 * writes a `.credentials.json` into it. readClaudeOAuthToken reads
 * `${configDir}/.credentials.json` (#4348), so without this every test that
 * reaches it would read the developer's real ~/.claude login.
 */
function isolatedConfigDir(): string {
  return join(tempDir, 'claude-config');
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
}

beforeEach(() => {
  // Redirect DATA_DIR to a temp directory for marker file tests.
  tempDir = fs.mkdtempSync(join(fs.realpathSync(require('os').tmpdir()), 'claude-mem-oauth-test-'));
  dataDirSpy = spyOn(paths, 'dataDir').mockImplementation(() => tempDir);
  // paths.settings() is frozen at module load, so point it at a per-test
  // settings file whose credential profile is isolatedConfigDir(). Tests that
  // need another profile overwrite this same file (stubSettingsFile below).
  const settingsPath = join(tempDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: isolatedConfigDir() }));
  settingsSpy = spyOn(paths, 'settings').mockImplementation(() => settingsPath);
});

afterEach(() => {
  dataDirSpy?.mockRestore();
  settingsSpy?.mockRestore();
  settingsSpy = undefined;
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
    expect(deriveMacKeychainServiceName(resolveClaudeCredentialProfile(tilde))).toBe(
      deriveMacKeychainServiceName(resolveClaudeCredentialProfile(absolute)),
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
    expect(deriveMacKeychainServiceName(resolveClaudeCredentialProfile('~/.claude/'))).toBe('Claude Code-credentials');
  });

  it('strips a trailing separator so an instance dir with a trailing slash matches its no-slash suffix', () => {
    const noSlash = '/Users/matthewdnye/.ccs/instances/iveg50';
    const withSlash = `${noSlash}/`;
    const resolvedNoSlash = resolveEffectiveClaudeConfigDir(noSlash);
    const resolvedWithSlash = resolveEffectiveClaudeConfigDir(withSlash);
    expect(resolvedWithSlash).toBe(resolvedNoSlash);
    expect(deriveMacKeychainServiceName(resolveClaudeCredentialProfile(withSlash))).toBe(
      deriveMacKeychainServiceName(resolveClaudeCredentialProfile(noSlash)),
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
    expect(deriveMacKeychainServiceName({ configDir: DEFAULT_CLAUDE_CONFIG_DIR, explicitConfigDir: false })).toBe('Claude Code-credentials');
  });

  it.each([
    ['/Users/matthewdnye/.ccs/instances/iveg50', 'faf0d083'],
    ['/Users/matthewdnye/.ccs/instances/nyem50', '7034a92a'],
    ['/Users/matthewdnye/.ccs/instances/qcom50', '8bb48066'],
    ['/Users/matthewdnye/.ccs/instances/flee50', '53f0e97f'],
    ['/Users/matthewdnye/.ccs/instances/nyeq50', 'e38871d4'],
    ['/Users/matthewdnye/.ccs/instances/repl00', '2e1325ac'],
  ])('suffixes %s as Claude Code-credentials-%s', (configDir, suffix) => {
    expect(deriveMacKeychainServiceName({ configDir, explicitConfigDir: true })).toBe(`Claude Code-credentials-${suffix}`);
  });

  // #4149 — Claude Code suffixes whenever CLAUDE_CONFIG_DIR is SET, even to
  // the default path, so an explicit default export is a suffixed entry.
  it('suffixes the default dir when it is explicitly configured', () => {
    const expectedSuffix = createHash('sha256').update(DEFAULT_CLAUDE_CONFIG_DIR).digest('hex').slice(0, 8);
    expect(deriveMacKeychainServiceName({ configDir: DEFAULT_CLAUDE_CONFIG_DIR, explicitConfigDir: true })).toBe(
      `Claude Code-credentials-${expectedSuffix}`,
    );
  });

  it('hashes the NFC form of the config dir, as Claude Code does', () => {
    const decomposedConfigDir = '/Users/josé/.claude-work';
    const composedConfigDir = '/Users/josé/.claude-work';
    expect(deriveMacKeychainServiceName({ configDir: decomposedConfigDir, explicitConfigDir: true })).toBe(
      deriveMacKeychainServiceName({ configDir: composedConfigDir, explicitConfigDir: true }),
    );
  });
});

/**
 * #4149 — the one predicate the SDK child env and the keychain read share.
 * Claude Code 2.1.285 treats a profile as the default iff CLAUDE_CONFIG_DIR is
 * unset (or empty); the value does not matter.
 */
describe('resolveClaudeCredentialProfile (#4149)', () => {
  const originalProcessEnvConfigDir = process.env.CLAUDE_CONFIG_DIR;

  afterEach(() => {
    if (originalProcessEnvConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalProcessEnvConfigDir;
    }
  });

  it('empty setting, nothing exported: the default profile', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(resolveClaudeCredentialProfile('').explicitConfigDir).toBe(false);
  });

  it('empty setting, CLAUDE_CONFIG_DIR exported as the default dir: explicit, like Claude Code', () => {
    process.env.CLAUDE_CONFIG_DIR = DEFAULT_CLAUDE_CONFIG_DIR;
    const profile = resolveClaudeCredentialProfile('');
    expect(profile.explicitConfigDir).toBe(true);
    expect(profile.configDir).toBe(resolveEffectiveClaudeConfigDir(''));
  });

  it('empty setting, CLAUDE_CONFIG_DIR exported as "": the default profile', () => {
    process.env.CLAUDE_CONFIG_DIR = '';
    expect(resolveClaudeCredentialProfile('').explicitConfigDir).toBe(false);
  });

  it('a setting naming the default dir is the default profile even when CLAUDE_CONFIG_DIR is exported', () => {
    process.env.CLAUDE_CONFIG_DIR = '/Users/someone/.claude-work';
    expect(resolveClaudeCredentialProfile('~/.claude')).toEqual({
      configDir: DEFAULT_CLAUDE_CONFIG_DIR,
      explicitConfigDir: false,
    });
  });

  it('a setting naming any other dir is explicit', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(resolveClaudeCredentialProfile('/custom/config/dir')).toEqual({
      configDir: '/custom/config/dir',
      explicitConfigDir: true,
    });
  });
});

/**
 * #2753 — readMacOsKeychain's injectable execImpl seam, exercised directly
 * (not through readClaudeOAuthToken/process.platform dispatch — see the
 * module-load comment on readMacOsKeychain for why the module-level
 * execFileAsync can't be intercepted post-hoc). Because execImpl is fully
 * injected here, this never shells out to the real `security` binary; it
 * runs on any host OS and never touches the real keychain.
 */
describe('readMacOsKeychain with an injected execImpl (#2753)', () => {
  it('searches the login keychain directly when the default search list misses the item', async () => {
    const futureExpiresAt = Date.now() + 60 * 60 * 1000;
    const payload = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-login-keychain-token', expiresAt: futureExpiresAt },
    });
    const calls: string[][] = [];
    const fakeExecImpl = mock(async (_cmd: string, args: readonly string[]) => {
      calls.push([...args]);
      if (calls.length === 1) {
        throw Object.assign(new Error('item not found in default keychain search list'), {
          code: 44,
          stderr: 'The specified item could not be found in the keychain.',
        });
      }
      return { stdout: payload, stderr: '' };
    }) as any;

    const result = await readMacOsKeychain('Claude Code-credentials', fakeExecImpl, 'kirat');

    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.token).toBe('sk-ant-oat01-login-keychain-token');
      expect(result.source).toBe('keychain');
      expect(result.expiresAt).toBe(futureExpiresAt);
    }
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'kirat', '-w']);
    expect(calls[1]).toEqual([
      ...calls[0],
      join(homedir(), 'Library', 'Keychains', 'login.keychain-db'),
    ]);
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
    const expectedServiceName = deriveMacKeychainServiceName(resolveClaudeCredentialProfile(instanceConfigDir));
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
    const expectedServiceName = deriveMacKeychainServiceName(resolveClaudeCredentialProfile(''));

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

  it('#4149: reads the SUFFIXED entry when CLAUDE_CONFIG_DIR is explicitly exported as the default dir', async () => {
    stubSettingsFile('');
    const originalProcessEnvConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = DEFAULT_CLAUDE_CONFIG_DIR;
    try {
      const expectedServiceName = deriveMacKeychainServiceName({
        configDir: resolveEffectiveClaudeConfigDir(''),
        explicitConfigDir: true,
      });
      expect(expectedServiceName).not.toBe('Claude Code-credentials');

      const payload = JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-ant-oat01-explicit-default', expiresAt: Date.now() + 60 * 60 * 1000 },
      });
      const fakeExecImpl = fakeExecFor(expectedServiceName, payload);

      const result = await readClaudeOAuthToken(fakeExecImpl);

      const callArgs = fakeExecImpl.mock.calls[0][1] as string[];
      expect(callArgs).toContain(expectedServiceName);
      expect(result.kind).toBe('present');
    } finally {
      if (originalProcessEnvConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalProcessEnvConfigDir;
      }
    }
  });
});

/**
 * #4037 — Claude Code stores the OAuth blob under `-a claude-code-user`
 * when the Unix username fails `/^[a-zA-Z0-9._-]+$/` (MDM Macs named
 * after an email). readMacOsKeychain must query that same account, not
 * the raw `userInfo().username`. username is injected (same reason as
 * execImpl) so this never depends on the host OS account.
 */
describe('sanitizeMacOsKeychainAccount (#4037)', () => {
  it('returns the raw username when it matches Claude Code\'s safe charset', () => {
    expect(sanitizeMacOsKeychainAccount('alex')).toBe('alex');
    expect(sanitizeMacOsKeychainAccount('alex.newman')).toBe('alex.newman');
    expect(sanitizeMacOsKeychainAccount('alex_newman-1')).toBe('alex_newman-1');
    expect(sanitizeMacOsKeychainAccount('Runner.01')).toBe('Runner.01');
  });

  it('falls back to claude-code-user when the username contains @ or other illegal chars', () => {
    expect(sanitizeMacOsKeychainAccount('first.last@example.com')).toBe('claude-code-user');
    expect(sanitizeMacOsKeychainAccount('alex newman')).toBe('claude-code-user');
    expect(sanitizeMacOsKeychainAccount('alex+mem')).toBe('claude-code-user');
    expect(sanitizeMacOsKeychainAccount('')).toBe('claude-code-user');
  });
});

describe('readMacOsKeychain (#4037) — keychain -a account follows Claude Code sanitize', () => {
  const futureExpiresAt = Date.now() + 60 * 60 * 1000;
  const payload = JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-account-token', expiresAt: futureExpiresAt },
  });

  function fakeExecForAccount(expectedAccount: string) {
    return mock((_cmd: string, args: readonly string[]) => {
      const accountArgIndex = args.indexOf('-a');
      const account = accountArgIndex >= 0 ? args[accountArgIndex + 1] : undefined;
      if (account === expectedAccount) {
        return Promise.resolve({ stdout: payload, stderr: '' });
      }
      return Promise.reject(new Error(`unexpected keychain account: ${account}`));
    });
  }

  it('queries account claude-code-user when the Unix username contains @', async () => {
    const fakeExecImpl = fakeExecForAccount('claude-code-user');
    const result = await readMacOsKeychain(
      'Claude Code-credentials',
      fakeExecImpl,
      'first.last@example.com',
    );

    expect(fakeExecImpl).toHaveBeenCalledTimes(1);
    const callArgs = fakeExecImpl.mock.calls[0][1] as string[];
    expect(callArgs[callArgs.indexOf('-a') + 1]).toBe('claude-code-user');
    expect(callArgs).not.toContain('first.last@example.com');
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.token).toBe('sk-ant-oat01-account-token');
    }
  });
});

/**
 * #4348 — Linux: OAuth lookup only checked libsecret, but Claude Code stores
 * credentials at `${configDir}/.credentials.json` (configDir defaults to
 * ~/.claude). These tests cover the file reader itself; the source order is
 * covered through readClaudeOAuthToken further down.
 */
describe('readClaudeCredentialsFile (#4348) — on-disk credentials file', () => {
  let credDir: string;

  beforeEach(() => {
    credDir = fs.mkdtempSync(join(fs.realpathSync(require('os').tmpdir()), 'claude-mem-creds-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(credDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  function writeCredentials(payload: unknown): void {
    const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
    fs.writeFileSync(join(credDir, '.credentials.json'), content);
  }

  it('returns token + expiry from the credentials file when present', () => {
    const futureExpiresAt = Date.now() + 60 * 60 * 1000;
    writeCredentials({ claudeAiOauth: { accessToken: '<redacted>', expiresAt: futureExpiresAt } });
    const result = readClaudeCredentialsFile(credDir);
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.token).toBe('<redacted>');
      expect(result.source).toBe('credentials-file');
      expect(result.expiresAt).toBe(futureExpiresAt);
    }
  });

  it('handles malformed JSON gracefully (absent, no throw)', () => {
    writeCredentials('{ this is not valid json');
    const result = readClaudeCredentialsFile(credDir);
    expect(result.kind).toBe('absent');
  });

  it('returns absent when the JSON has no claudeAiOauth.accessToken', () => {
    writeCredentials({ claudeAiOauth: { refreshToken: 'refresh-x' } });
    const result = readClaudeCredentialsFile(credDir);
    expect(result.kind).toBe('absent');
  });

  it('treats a JSON array payload as absent instead of throwing', () => {
    writeCredentials('[]');
    expect(readClaudeCredentialsFile(credDir).kind).toBe('absent');
  });

  it('rejects non-string access tokens with and without an explicit expiry', () => {
    for (const accessToken of [42, true, {}, []]) {
      for (const expiresAt of [undefined, Date.now() + 3_600_000]) {
        writeCredentials({ claudeAiOauth: { accessToken, expiresAt } });
        expect(readClaudeCredentialsFile(credDir).kind).toBe('absent');
      }
    }
  });
});

describe('test isolation (#4369 review) — no test reads the real Claude Code login', () => {
  it('resolves the credential profile inside the per-test temp dir', () => {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    const profile = resolveClaudeCredentialProfile(settings.CLAUDE_MEM_CLAUDE_CONFIG_DIR);
    expect(profile.configDir.startsWith(tempDir)).toBe(true);
  });
});

const inAnHour = () => Date.now() + 60 * 60 * 1000;
const tenMinutesAgo = () => Date.now() - 10 * 60 * 1000;
const credentialJson = (accessToken: string, expiresAt: number = inAnHour()) =>
  JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } });
const storeReturns = (stdout: string) => mock(() => Promise.resolve({ stdout, stderr: '' })) as any;
const storeMisses = () => mock(() => Promise.reject(new Error('no matching entry'))) as any;

function writeCredentialsFile(content: string): void {
  fs.mkdirSync(isolatedConfigDir(), { recursive: true });
  fs.writeFileSync(join(isolatedConfigDir(), '.credentials.json'), content);
}

/**
 * #4348 (Linux) / #4246 (Windows): Claude Code keeps its live login in
 * `${configDir}/.credentials.json` everywhere but macOS, so that file is read
 * first there, and libsecret / Credential Manager only when it is absent. On
 * macOS the keychain stays first and the file is its fallback.
 */
describe('readClaudeOAuthToken (#4348, #4246) — reads the store Claude Code writes first', () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it('linux: reads the credentials file first and never queries libsecret', async () => {
    setPlatform('linux');
    writeCredentialsFile(credentialJson('sk-ant-oat01-file'));
    const execImpl = storeReturns(credentialJson('sk-ant-oat01-libsecret'));
    const result = await readClaudeOAuthToken(execImpl);
    expect(result).toMatchObject({ kind: 'present', token: 'sk-ant-oat01-file', source: 'credentials-file' });
    expect(execImpl).not.toHaveBeenCalled();
  });

  it('linux: without a credentials file, a libsecret entry is still used', async () => {
    setPlatform('linux');
    const execImpl = storeReturns(credentialJson('sk-ant-oat01-libsecret'));
    const result = await readClaudeOAuthToken(execImpl);
    expect(result).toMatchObject({ kind: 'present', token: 'sk-ant-oat01-libsecret', source: 'keychain' });
    expect(execImpl.mock.calls[0][0]).toBe('secret-tool');
  });

  it('linux: when both miss, the reason names the file it checked instead of sending users to install secret-tool', async () => {
    setPlatform('linux');
    const result = await readClaudeOAuthToken(storeMisses());
    expect(result.kind).toBe('absent');
    if (result.kind === 'absent') {
      expect(result.reason).toContain(join(isolatedConfigDir(), '.credentials.json'));
      expect(result.reason).not.toContain('is secret-tool installed?');
    }
  });

  it('win32: the live credentials file beats a stale Credential Manager entry (#4246)', async () => {
    setPlatform('win32');
    writeCredentialsFile(credentialJson('sk-ant-oat01-live-login'));
    const execImpl = storeReturns(credentialJson('sk-ant-oat01-previous-account'));
    const result = await readClaudeOAuthToken(execImpl);
    expect(result).toMatchObject({ kind: 'present', token: 'sk-ant-oat01-live-login', source: 'credentials-file' });
    expect(execImpl).not.toHaveBeenCalled();
  });

  it('win32: without a credentials file, the Credential Manager entry is used', async () => {
    setPlatform('win32');
    const execImpl = storeReturns(credentialJson('sk-ant-oat01-credman'));
    const result = await readClaudeOAuthToken(execImpl);
    expect(result).toMatchObject({ kind: 'present', token: 'sk-ant-oat01-credman', source: 'keychain' });
    expect(execImpl.mock.calls[0][0]).toBe('powershell.exe');
  });

  it('darwin: the keychain is read first and wins over the credentials file', async () => {
    setPlatform('darwin');
    writeCredentialsFile(credentialJson('sk-ant-oat01-file'));
    const result = await readClaudeOAuthToken(storeReturns(credentialJson('sk-ant-oat01-keychain')));
    expect(result).toMatchObject({ kind: 'present', token: 'sk-ant-oat01-keychain', source: 'keychain' });
  });

  it('darwin: a keychain miss falls back to the credentials file', async () => {
    setPlatform('darwin');
    writeCredentialsFile(credentialJson('sk-ant-oat01-file'));
    const result = await readClaudeOAuthToken(storeMisses());
    expect(result).toMatchObject({ kind: 'present', token: 'sk-ant-oat01-file', source: 'credentials-file' });
  });
});

/**
 * plan-19 (#3607) item 4: a usable CLAUDE_CODE_OAUTH_TOKEN always beats an
 * expired stored credential, so a headless box with an old login on disk or
 * in the keychain keeps working (#3121). With nothing usable, the stored
 * expiry is still reported, so the "run /login" marker fires.
 */
describe('readClaudeOAuthToken (plan-19) — a usable env token beats an expired stored credential', () => {
  it('linux: expired credentials file + valid CLAUDE_CODE_OAUTH_TOKEN → the env token', async () => {
    setPlatform('linux');
    writeCredentialsFile(credentialJson('sk-ant-oat01-stale', tenMinutesAgo()));
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-env';
    const result = await readClaudeOAuthToken(storeMisses());
    expect(result).toMatchObject({ kind: 'present', token: 'sk-ant-oat01-env', source: 'env-fallback' });
  });

  it('darwin: expired keychain entry + valid CLAUDE_CODE_OAUTH_TOKEN → the env token (#3121)', async () => {
    setPlatform('darwin');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-env';
    const result = await readClaudeOAuthToken(storeReturns(credentialJson('sk-ant-oat01-stale', tenMinutesAgo())));
    expect(result).toMatchObject({ kind: 'present', token: 'sk-ant-oat01-env', source: 'env-fallback' });
  });

  it('linux: expired credentials file and no env token → expired, so the stale-login marker still fires', async () => {
    setPlatform('linux');
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const expiresAt = tenMinutesAgo();
    writeCredentialsFile(credentialJson('sk-ant-oat01-stale', expiresAt));
    const result = await readClaudeOAuthToken(storeMisses());
    expect(result).toMatchObject({ kind: 'expired', expiresAt });
  });

  it('linux: a credentials file holding JSON null does not throw, and the env token is still used', async () => {
    setPlatform('linux');
    writeCredentialsFile('null');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-env';
    const result = await readClaudeOAuthToken(storeMisses());
    expect(result).toMatchObject({ kind: 'present', token: 'sk-ant-oat01-env', source: 'env-fallback' });
  });
});
