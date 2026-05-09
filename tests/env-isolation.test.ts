import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import { dirname } from 'path';
import {
  ENV_FILE_PATH,
  buildIsolatedEnv,
  buildIsolatedEnvWithFreshOAuth,
} from '../src/shared/EnvManager.js';
import * as oauthToken from '../src/shared/oauth-token.js';

/**
 * Tests for issue #2375: ANTHROPIC_BASE_URL must not leak from the parent
 * shell into the spawned worker's isolatedEnv, AND the OAuth-skip predicate
 * must not inject the user's Anthropic OAuth token onto a custom gateway URL
 * (which would be a token leak to a third party).
 *
 * ENV_FILE_PATH is captured at module load time, so we cannot easily redirect
 * the env file by mocking paths.envFile() after the fact. Instead, we
 * back up the user's real ~/.claude-mem/.env (if any), write a temp file at
 * the canonical ENV_FILE_PATH for each test, and restore afterwards.
 */

const ORIGINAL_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
const ORIGINAL_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;

const ENV_FILE_BACKUP_PATH = `${ENV_FILE_PATH}.test-backup`;

function backupEnvFile(): void {
  if (fs.existsSync(ENV_FILE_PATH)) {
    fs.renameSync(ENV_FILE_PATH, ENV_FILE_BACKUP_PATH);
  }
}

function restoreEnvFile(): void {
  if (fs.existsSync(ENV_FILE_PATH)) {
    fs.unlinkSync(ENV_FILE_PATH);
  }
  if (fs.existsSync(ENV_FILE_BACKUP_PATH)) {
    fs.renameSync(ENV_FILE_BACKUP_PATH, ENV_FILE_PATH);
  }
}

function ensureEnvDir(): void {
  const dir = dirname(ENV_FILE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function clearAnthropicEnv(): void {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

function restoreOriginalEnv(): void {
  if (ORIGINAL_BASE_URL === undefined) {
    delete process.env.ANTHROPIC_BASE_URL;
  } else {
    process.env.ANTHROPIC_BASE_URL = ORIGINAL_BASE_URL;
  }
  if (ORIGINAL_API_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
  }
  if (ORIGINAL_AUTH_TOKEN === undefined) {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  } else {
    process.env.ANTHROPIC_AUTH_TOKEN = ORIGINAL_AUTH_TOKEN;
  }
  if (ORIGINAL_OAUTH_TOKEN === undefined) {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIGINAL_OAUTH_TOKEN;
  }
}

describe('Issue #2375: ANTHROPIC_BASE_URL env-var isolation', () => {
  beforeEach(() => {
    backupEnvFile();
    ensureEnvDir();
    clearAnthropicEnv();
  });

  afterEach(() => {
    restoreEnvFile();
    restoreOriginalEnv();
  });

  it('leaked ANTHROPIC_BASE_URL is stripped from isolatedEnv', () => {
    // No ~/.claude-mem/.env file exists (backed up above). The parent shell
    // sets a stray ANTHROPIC_BASE_URL — this MUST NOT propagate into the
    // subprocess isolatedEnv, because doing so used to trigger the
    // OAuth-skip path and leave the worker with no credentials at all.
    process.env.ANTHROPIC_BASE_URL = 'https://shouldnotleak.example';

    const result = buildIsolatedEnv();

    expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('~/.claude-mem/.env BASE_URL + AUTH_TOKEN reaches isolatedEnv', () => {
    // User intentionally configured a gateway with a gateway-appropriate
    // auth token. Both must be re-injected into isolatedEnv.
    fs.writeFileSync(
      ENV_FILE_PATH,
      'ANTHROPIC_BASE_URL=https://gateway.example\nANTHROPIC_AUTH_TOKEN=test-token\n',
      { mode: 0o600 },
    );

    const result = buildIsolatedEnv();

    expect(result.ANTHROPIC_BASE_URL).toBe('https://gateway.example');
    expect(result.ANTHROPIC_AUTH_TOKEN).toBe('test-token');
  });

  it('bare .env BASE_URL alone does not trigger OAuth fetch', async () => {
    // A user with a tokenless gateway (e.g. mTLS at the network boundary)
    // configures BASE_URL only. The three-branch predicate must hit the
    // BASE_URL-set branch BEFORE OAuth lookup, so CLAUDE_CODE_OAUTH_TOKEN
    // must NOT appear in the result. This is the security-regression guard
    // against a token leak to a third-party gateway.
    //
    // Note: EnvManager captures readClaudeOAuthToken via a named import at
    // module load, so spyOn on the namespace export only weakly observes
    // the call (the binding inside EnvManager is independent). The
    // behavioral assertions (BASE_URL re-injected AND OAuth token NOT
    // injected) are the load-bearing checks: in the no-OAuth-injection
    // outcome, the only execution path that produces this combination is
    // the new BASE_URL-first branch returning early.
    fs.writeFileSync(
      ENV_FILE_PATH,
      'ANTHROPIC_BASE_URL=https://gateway.example\n',
      { mode: 0o600 },
    );

    const oauthSpy = spyOn(oauthToken, 'readClaudeOAuthToken');

    const result = await buildIsolatedEnvWithFreshOAuth();

    expect(result.ANTHROPIC_BASE_URL).toBe('https://gateway.example');
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // Best-effort sanity check; see note above.
    expect(oauthSpy).not.toHaveBeenCalled();

    oauthSpy.mockRestore();
  });
});
