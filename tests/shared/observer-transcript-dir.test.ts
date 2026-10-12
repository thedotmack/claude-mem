/**
 * Issue #4689 — observer/SDK session transcripts must be separable from the
 * credential identity.
 *
 * Root cause: under the default credential profile, buildIsolatedEnv deletes
 * CLAUDE_CONFIG_DIR from the SDK child env (#4149), so the child falls back to
 * ~/.claude and persists every internal session transcript into
 * ~/.claude/projects/<munged observer cwd>/ — which tools like Codex then
 * import as user chats. Pointing CLAUDE_MEM_CLAUDE_CONFIG_DIR at an isolated
 * dir moves the transcripts, but it is ALSO the credential identity: the
 * keychain lookup switches to a suffixed entry that dir was never logged in
 * with, so the observer runs credential-less (#2753/#4149 coupling).
 *
 * The fix: a transcript-only setting, CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR.
 * When the credential profile is the DEFAULT one and this setting is
 * non-empty, the SDK child env gets CLAUDE_CONFIG_DIR stamped to it (transcript
 * placement only), while the worker keeps resolving credentials from the
 * default profile and injects CLAUDE_CODE_OAUTH_TOKEN at spawn time
 * (buildIsolatedEnvWithFreshOAuth). An explicit CLAUDE_MEM_CLAUDE_CONFIG_DIR
 * profile is untouched: it keeps stamping its own dir (#2753 semantics).
 *
 * These tests pin all three legs the work order calls out:
 *   1. the child env's CLAUDE_CONFIG_DIR points at the independent dir,
 *   2. the keychain service name stays derived from the DEFAULT profile,
 *   3. the env-fallback CLAUDE_CODE_OAUTH_TOKEN injection does not regress.
 *
 * Hermeticity: the frozen paths.CLAUDE_CONFIG_DIR is pinned to an empty temp
 * dir BEFORE the module graph loads (so a developer's real ~/.claude
 * credentials file is never read), platform is spoofed away from darwin where
 * a keychain subprocess would fire, and the keychain dispatch itself is
 * driven through readClaudeOAuthToken's injected execImpl seam — the real
 * `security` binary is never shelled out to.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as fs from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import * as childProcess from 'child_process';

// Captured BEFORE the override below, so afterEach puts the real value back
// and later files in the same bun process never inherit the temp profile.
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

// Must run before any src import freezes paths.CLAUDE_CONFIG_DIR.
const FROZEN_CONFIG_DIR = join(fs.realpathSync(tmpdir()), 'claude-mem-4689-frozen-config');
fs.mkdirSync(FROZEN_CONFIG_DIR, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = FROZEN_CONFIG_DIR;

const { buildIsolatedEnv, buildIsolatedEnvWithFreshOAuth, resolveConfigDirProfileKey } = await import(
  '../../src/shared/EnvManager.js'
);
const { readClaudeOAuthToken, deriveMacKeychainServiceName, resolveClaudeCredentialProfile } = await import(
  '../../src/shared/oauth-token.js'
);
type OAuthTokenResult = Awaited<ReturnType<typeof readClaudeOAuthToken>>;
const { paths } = await import('../../src/shared/paths.js');

const TRANSCRIPT_DIR = join(FROZEN_CONFIG_DIR, '..', 'claude-mem-4689-transcripts');
const KEYCHAIN_SERVICE_NAME = 'Claude Code-credentials';

/**
 * bun test shares one process (module cache + process.env) across files, so
 * paths.CLAUDE_CONFIG_DIR may have been frozen by an earlier file to the
 * machine's real default dir. Never assert a frozen value: derive
 * expectations from the same resolution the production code performs.
 */
function defaultProfileConfigDir(): string {
  return resolveClaudeCredentialProfile('').configDir;
}

/**
 * What buildIsolatedEnvWithFreshOAuth's stored-credential read will resolve
 * to on this machine, probed WITHOUT the env token in play (platform 'aix':
 * the file branch reads defaultProfileConfigDir(), no subprocess ever
 * fires). A VALID stored login beats the env fallback by design (#3121 —
 * the env token only outranks an EXPIRED stored one), so tests that assert
 * the injected token consult this probe first.
 */
async function probeStoredCredential(): Promise<OAuthTokenResult> {
  const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    setPlatform('aix');
    return await readClaudeOAuthToken(mock(() => Promise.reject(new Error('no keychain subprocess under test'))));
  } finally {
    setEnvVar('CLAUDE_CODE_OAUTH_TOKEN', previousToken);
    restorePlatform();
  }
}

let settingsSpy: ReturnType<typeof spyOn> | undefined;
let dataDirSpy: ReturnType<typeof spyOn> | undefined;
let tempDir: string;
let settingsPath: string;

const ORIGINAL_ENV = {
  CLAUDE_CONFIG_DIR: ORIGINAL_CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  CLAUDE_MEM_ENV_FILE: process.env.CLAUDE_MEM_ENV_FILE,
};

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
}

function setEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Write the settings file the spied paths.settings() returns. */
function stubSettingsFile(settings: Record<string, string>): void {
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
}

/** Default credential profile for a test body: no inherited CLAUDE_CONFIG_DIR. */
function useDefaultProfile(): void {
  delete process.env.CLAUDE_CONFIG_DIR;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'claude-mem-4689-'));
  settingsPath = join(tempDir, 'settings.json');
  stubSettingsFile({});
  settingsSpy = spyOn(paths, 'settings').mockImplementation(() => settingsPath);
  dataDirSpy = spyOn(paths, 'dataDir').mockImplementation(() => tempDir);
  // .env re-injection must stay out of these tests, and the OAuth-skip
  // predicates must not fire on values an earlier test file left behind.
  process.env.CLAUDE_MEM_ENV_FILE = join(tempDir, 'nonexistent.env');
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  useDefaultProfile();
});

afterEach(() => {
  settingsSpy?.mockRestore();
  dataDirSpy?.mockRestore();
  settingsSpy = undefined;
  dataDirSpy = undefined;
  restorePlatform();
  setEnvVar('CLAUDE_CONFIG_DIR', ORIGINAL_ENV.CLAUDE_CONFIG_DIR);
  setEnvVar('CLAUDE_CODE_OAUTH_TOKEN', ORIGINAL_ENV.CLAUDE_CODE_OAUTH_TOKEN);
  setEnvVar('ANTHROPIC_BASE_URL', ORIGINAL_ENV.ANTHROPIC_BASE_URL);
  setEnvVar('ANTHROPIC_API_KEY', ORIGINAL_ENV.ANTHROPIC_API_KEY);
  setEnvVar('ANTHROPIC_AUTH_TOKEN', ORIGINAL_ENV.ANTHROPIC_AUTH_TOKEN);
  setEnvVar('CLAUDE_MEM_ENV_FILE', ORIGINAL_ENV.CLAUDE_MEM_ENV_FILE);
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('#4689 — transcript-only CLAUDE_CONFIG_DIR for the SDK child', () => {
  it('stamps the transcript-only dir onto the child env under the default credential profile', () => {
    stubSettingsFile({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '', CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR: TRANSCRIPT_DIR });

    const result = buildIsolatedEnv();

    expect(result.CLAUDE_CONFIG_DIR).toBe(TRANSCRIPT_DIR);
  });

  it('expands a leading ~ like the sister setting does (settings-file/UI values never pass through a shell)', () => {
    // The docs example is '~/.claude-mem/observer-claude'. Stamped verbatim,
    // the literal '~' reaches the child and the CLI creates <worker cwd>/~/…
    // (verified with the vendored CLI during review) — and resume breaks as
    // soon as the worker cwd changes. The value must get the same
    // resolveEffectiveClaudeConfigDir normalization as
    // CLAUDE_MEM_CLAUDE_CONFIG_DIR: trim → expandTilde → stripTrailingSep.
    stubSettingsFile({
      CLAUDE_MEM_CLAUDE_CONFIG_DIR: '',
      CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR: '~/.claude-mem/observer-claude',
    });

    const result = buildIsolatedEnv();

    expect(result.CLAUDE_CONFIG_DIR).toBe(join(homedir(), '.claude-mem', 'observer-claude'));
  });

  it('strips trailing path separators like the sister setting does', () => {
    stubSettingsFile({
      CLAUDE_MEM_CLAUDE_CONFIG_DIR: '',
      CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR: `${TRANSCRIPT_DIR}/`,
    });

    const result = buildIsolatedEnv();

    expect(result.CLAUDE_CONFIG_DIR).toBe(TRANSCRIPT_DIR);
  });

  it('leaves CLAUDE_CONFIG_DIR unset when the transcript-only setting is empty (#4149 guard)', () => {
    stubSettingsFile({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '', CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR: '' });

    const result = buildIsolatedEnv();

    expect(result.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('treats a whitespace-only transcript-only setting as unset', () => {
    stubSettingsFile({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '', CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR: '   ' });

    const result = buildIsolatedEnv();

    expect(result.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('an explicit CLAUDE_MEM_CLAUDE_CONFIG_DIR profile wins: its dir is stamped and the transcript-only setting is ignored (#2753 preserved)', () => {
    const profileDir = join(tempDir, 'claude-profile');
    stubSettingsFile({
      CLAUDE_MEM_CLAUDE_CONFIG_DIR: profileDir,
      CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR: TRANSCRIPT_DIR,
    });

    const result = buildIsolatedEnv();

    expect(result.CLAUDE_CONFIG_DIR).toBe(profileDir);
    expect(result.CLAUDE_CONFIG_DIR).not.toBe(TRANSCRIPT_DIR);
  });

  it('keeps the quota/profile key on the default credential identity while transcripts are redirected', () => {
    stubSettingsFile({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '', CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR: TRANSCRIPT_DIR });

    expect(resolveConfigDirProfileKey()).toBe('default');
  });

  it('does not let the transcript-only dir shadow a deleted child CLAUDE_CONFIG_DIR when the credential profile is explicit via process.env', () => {
    // A user who exports CLAUDE_CONFIG_DIR (not the setting) has an explicit
    // profile too: the transcript-only setting must not override the stamp
    // that keeps child and worker on the same keychain identity (#4149).
    // The stamped value is resolveClaudeCredentialProfile('').configDir —
    // whatever effective dir the profile resolves to — never the
    // transcript-only dir.
    process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'claude-env-profile');
    stubSettingsFile({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '', CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR: TRANSCRIPT_DIR });

    const result = buildIsolatedEnv();

    expect(result.CLAUDE_CONFIG_DIR).toBe(defaultProfileConfigDir());
    expect(result.CLAUDE_CONFIG_DIR).not.toBe(TRANSCRIPT_DIR);
  });
});

describe('#4689 — credential identity is unaffected by the transcript-only dir', () => {
  it('darwin dispatch still queries the BARE default keychain entry while transcripts are redirected', async () => {
    setPlatform('darwin');
    stubSettingsFile({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '', CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR: TRANSCRIPT_DIR });

    const profile = resolveClaudeCredentialProfile('');
    expect(profile.explicitConfigDir).toBe(false);
    // Sanity: the transcript dir would hash to a DIFFERENT service name if
    // the credential profile wrongly followed it.
    const suffixedName = deriveMacKeychainServiceName({ configDir: TRANSCRIPT_DIR, explicitConfigDir: true });
    expect(suffixedName).not.toBe(KEYCHAIN_SERVICE_NAME);

    const futureExpiresAt = Date.now() + 60 * 60 * 1000;
    const payload = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-4689-default-profile', expiresAt: futureExpiresAt },
    });
    const fakeExecImpl = mock((_cmd: string, args: readonly string[]) => {
      const serviceArgIndex = args.indexOf('-s');
      const serviceName = serviceArgIndex >= 0 ? args[serviceArgIndex + 1] : undefined;
      if (serviceName === KEYCHAIN_SERVICE_NAME) {
        return Promise.resolve({ stdout: payload, stderr: '' });
      }
      return Promise.reject(new Error(`unexpected keychain service name: ${serviceName}`));
    });

    const result = await readClaudeOAuthToken(fakeExecImpl);

    expect(fakeExecImpl).toHaveBeenCalledTimes(1);
    const callArgs = fakeExecImpl.mock.calls[0][1] as string[];
    expect(callArgs).toContain(KEYCHAIN_SERVICE_NAME);
    expect(callArgs).not.toContain(suffixedName);
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.source).toBe('keychain');
      expect(result.token).toBe('sk-ant-oat01-4689-default-profile');
    }
  });

  it('env-fallback still wins when the default keychain entry is missing (the #4689 reporter scenario)', async () => {
    setPlatform('darwin');
    stubSettingsFile({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '', CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR: TRANSCRIPT_DIR });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-4689-env-fallback';

    const fakeExecImpl = mock((_cmd: string, _args: readonly string[]) => {
      return Promise.reject(new Error('The specified item could not be found in the keychain.'));
    });

    const result = await readClaudeOAuthToken(fakeExecImpl);

    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.source).toBe('env-fallback');
      expect(result.token).toBe('sk-ant-oat01-4689-env-fallback');
    }
  });
});

describe('#4689 — buildIsolatedEnvWithFreshOAuth injects a usable credential into the redirected child', () => {
  it('with the transcript-only dir set, the child env carries BOTH the redirected CLAUDE_CONFIG_DIR and a fresh injected token', async () => {
    const envToken = 'sk-ant-oat01-4689-fresh-spawn';
    const storedProbe = await probeStoredCredential();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = envToken;
    // 'aix' is unsupported by every credential-store branch: no keychain or
    // libsecret subprocess ever fires, so the run is hermetic. (The file
    // branch reads defaultProfileConfigDir(); probeStoredCredential already
    // accounted for whatever a file-based login on this machine provides.)
    setPlatform('aix');
    stubSettingsFile({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '', CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR: TRANSCRIPT_DIR });

    const result = await buildIsolatedEnvWithFreshOAuth();

    expect(result.CLAUDE_CONFIG_DIR).toBe(TRANSCRIPT_DIR);
    if (storedProbe.kind === 'present') {
      // A valid stored login exists on this machine and outranks the env
      // fallback (#3121 ordering) — the injected token must be THAT one.
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe(storedProbe.token);
    } else {
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe(envToken);
    }
    // The OAuth-skip predicates must not have fired.
    expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('without the transcript-only dir, the child env stays CLAUDE_CONFIG_DIR-free and still gets the token (#4149 guard)', async () => {
    const envToken = 'sk-ant-oat01-4689-fresh-spawn';
    const storedProbe = await probeStoredCredential();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = envToken;
    setPlatform('aix');
    stubSettingsFile({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '', CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR: '' });

    const result = await buildIsolatedEnvWithFreshOAuth();

    expect(result.CLAUDE_CONFIG_DIR).toBeUndefined();
    if (storedProbe.kind === 'present') {
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe(storedProbe.token);
    } else {
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe(envToken);
    }
  });
});
