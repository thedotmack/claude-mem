import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildIsolatedEnv, buildIsolatedEnvWithFreshOAuth } from '../../src/shared/EnvManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import {
  readClaudeOAuthToken,
  resolveClaudeCredentialProfile,
  deriveMacKeychainServiceName,
  resolveEffectiveClaudeConfigDir,
} from '../../src/shared/oauth-token.js';
import { paths, DEFAULT_CLAUDE_CONFIG_DIR } from '../../src/shared/paths.js';

/**
 * #4689 — Observer/KnowledgeAgent SDK subprocesses persist session transcripts
 * under `${CLAUDE_CONFIG_DIR}/projects/<munged-cwd>/`. Under the default
 * credential profile, buildIsolatedEnv deliberately strips CLAUDE_CONFIG_DIR
 * from the child (#4149), so the child's config root is ~/.claude and its
 * transcripts land in ~/.claude/projects — where Codex and similar tools
 * import them as user chats.
 *
 * CLAUDE_MEM_CLAUDE_CONFIG_DIR cannot fix this, because it is the credential
 * IDENTITY setting: the same profile derives the macOS keychain service name
 * (deriveMacKeychainServiceName), so pointing it at a fresh dir makes the
 * child hunt a suffixed keychain entry no login ever created (#2753/#4149).
 *
 * The fix: a transcript-only setting, CLAUDE_MEM_SDK_CLAUDE_CONFIG_DIR. When
 * set, the SDK child gets CLAUDE_CONFIG_DIR stamped to it (transcripts land
 * under <dir>/projects, outside ~/.claude), while credential resolution keeps
 * reading the CLAUDE_MEM_CLAUDE_CONFIG_DIR profile and auth reaches the child
 * via the existing spawn-time CLAUDE_CODE_OAUTH_TOKEN injection
 * (buildIsolatedEnvWithFreshOAuth). These tests pin both halves of that split:
 * the child ENV carries the transcript dir, and the credential/keychain
 * identity stays derived from the credential setting alone.
 *
 * Mocking conventions are the ones tests/env-isolation.test.ts and
 * tests/shared/oauth-token.test.ts already established:
 *  - SettingsDefaultsManager.loadFromFile is a static method, so spyOn on the
 *    class is observed by every importer (EnvManager included) without
 *    touching the real ~/.claude-mem/settings.json.
 *  - readClaudeOAuthToken's execImpl seam keeps the real `security` binary out
 *    of the test; platform is spoofed to darwin so the macOS branch runs on
 *    any host OS.
 */

let loadFromFileSpy: ReturnType<typeof spyOn> | undefined;

function stubSettings(overrides: Partial<{ CLAUDE_MEM_CLAUDE_CONFIG_DIR: string; CLAUDE_MEM_SDK_CLAUDE_CONFIG_DIR: string }>): void {
  loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(
    () =>
      ({
        ...SettingsDefaultsManager.getAllDefaults(),
        ...overrides,
      }) as any
  );
}

function withProcessEnvConfigDir(value: string | undefined, run: () => void): void {
  const original = process.env.CLAUDE_CONFIG_DIR;
  if (value === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = value;
  }
  try {
    run();
  } finally {
    if (original === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = original;
    }
  }
}

afterEach(() => {
  loadFromFileSpy?.mockRestore();
  loadFromFileSpy = undefined;
});

describe('#4689: CLAUDE_MEM_SDK_CLAUDE_CONFIG_DIR stamps a transcript-only config dir on the SDK subprocess', () => {
  it('the child env carries the transcript dir even under the default credential profile', () => {
    // Default credential profile (setting empty): #4149 semantics say the
    // child must NOT carry the profile's config dir — but the transcript-only
    // setting is exactly the escape hatch the default profile lacked: the var
    // is set, so transcripts go under <dir>/projects, while the worker keeps
    // injecting the default profile's token at spawn time.
    stubSettings({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '', CLAUDE_MEM_SDK_CLAUDE_CONFIG_DIR: '/tmp/sdk-transcripts' });

    withProcessEnvConfigDir(undefined, () => {
      const result = buildIsolatedEnv();

      expect(result.CLAUDE_CONFIG_DIR).toBe('/tmp/sdk-transcripts');
      expect(result.CLAUDE_CONFIG_DIR).not.toBe(DEFAULT_CLAUDE_CONFIG_DIR);
    });
  });

  it('resolves through resolveEffectiveClaudeConfigDir (tilde expansion + trailing-separator strip)', () => {
    stubSettings({ CLAUDE_MEM_SDK_CLAUDE_CONFIG_DIR: '~/.claude-mem/sdk-sessions/' });

    const result = buildIsolatedEnv();

    expect(result.CLAUDE_CONFIG_DIR).toBe(resolveEffectiveClaudeConfigDir('~/.claude-mem/sdk-sessions/'));
    expect(result.CLAUDE_CONFIG_DIR?.endsWith('/')).toBe(false);
    expect(result.CLAUDE_CONFIG_DIR?.startsWith('/')).toBe(true);
  });

  it('an empty setting leaves the #4149 default-profile behavior untouched (no CLAUDE_CONFIG_DIR)', () => {
    stubSettings({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '', CLAUDE_MEM_SDK_CLAUDE_CONFIG_DIR: '' });

    withProcessEnvConfigDir(undefined, () => {
      expect(buildIsolatedEnv().CLAUDE_CONFIG_DIR).toBeUndefined();
    });
  });

  it('the transcript dir wins on the child env when both settings are set, but the credential profile still resolves from CLAUDE_MEM_CLAUDE_CONFIG_DIR', () => {
    stubSettings({
      CLAUDE_MEM_CLAUDE_CONFIG_DIR: '/tmp/credential-profile',
      CLAUDE_MEM_SDK_CLAUDE_CONFIG_DIR: '/tmp/sdk-transcripts',
    });

    const result = buildIsolatedEnv();

    // Child env: transcript dir (the whole point — its config root IS where
    // transcripts go).
    expect(result.CLAUDE_CONFIG_DIR).toBe('/tmp/sdk-transcripts');
    // Credential identity: derived from the credential setting alone — the
    // suffixed keychain service name Claude Code uses for THAT profile, never
    // one derived from the transcript dir.
    const suffixOf = (dir: string): string =>
      createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8);
    const credentialServiceName = deriveMacKeychainServiceName(resolveClaudeCredentialProfile('/tmp/credential-profile'));
    expect(credentialServiceName).toBe(`Claude Code-credentials-${suffixOf('/tmp/credential-profile')}`);
    expect(credentialServiceName).not.toBe(`Claude Code-credentials-${suffixOf('/tmp/sdk-transcripts')}`);
  });
});

describe('#4689: the credential/keychain identity ignores the transcript-only setting', () => {
  let settingsPathSpy: ReturnType<typeof spyOn> | undefined;
  let tempDir: string;

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'claude-mem-sdk-transcripts-test-'));
    // Default credential profile (CLAUDE_MEM_CLAUDE_CONFIG_DIR empty) WHILE
    // the transcript-only setting points elsewhere. If readClaudeOAuthToken
    // ever starts consuming the transcript setting, the keychain lookup moves
    // to a suffixed entry no login created — the exact #2753/#4149 failure
    // this split exists to avoid. The -s argument it passes is the pin.
    const settingsPath = join(tempDir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '', CLAUDE_MEM_SDK_CLAUDE_CONFIG_DIR: '/tmp/sdk-transcripts' })
    );
    settingsPathSpy = spyOn(paths, 'settings').mockImplementation(() => settingsPath);
  });

  afterEach(() => {
    settingsPathSpy?.mockRestore();
    settingsPathSpy = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
    setPlatform('darwin');
  });

  it('readClaudeOAuthToken queries the BARE default keychain entry while the transcript dir is set', async () => {
    setPlatform('darwin');

    const seenServiceNames: string[] = [];
    const execImpl = (async (_cmd: string, args: readonly string[]) => {
      const idx = args.indexOf('-s');
      if (idx >= 0) seenServiceNames.push(args[idx + 1]);
      // Act like an empty default keychain: the lookup misses.
      throw new Error('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.');
    }) as any;

    const result = await readClaudeOAuthToken(execImpl);

    // The default profile's bare entry — NOT a suffixed one derived from
    // /tmp/sdk-transcripts.
    expect(seenServiceNames).toContain('Claude Code-credentials');
    for (const name of seenServiceNames) {
      expect(name.startsWith('Claude Code-credentials-')).toBe(false);
    }
    // The lookup missed (absent), which is the expected shape in a test
    // environment with no keychain entry.
    expect(result.kind).toBe('absent');
  });
});

describe('#4689: buildIsolatedEnvWithFreshOAuth inherits the transcript-dir stamp', () => {
  it('includeCredentials=false short-circuits before keychain but still carries the stamp', async () => {
    stubSettings({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '', CLAUDE_MEM_SDK_CLAUDE_CONFIG_DIR: '/tmp/sdk-transcripts-via-fresh-oauth' });

    const result = await buildIsolatedEnvWithFreshOAuth(false);

    expect(result.CLAUDE_CONFIG_DIR).toBe('/tmp/sdk-transcripts-via-fresh-oauth');
  });
});
