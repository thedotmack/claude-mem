import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  envFilePath,
  buildIsolatedEnv,
  buildIsolatedEnvWithFreshOAuth,
} from '../src/shared/EnvManager.js';
import { sanitizeEnv } from '../src/supervisor/env-sanitizer.js';
import * as oauthToken from '../src/shared/oauth-token.js';
// CJS interop: the check is a .cjs module exporting findViolations.
import { createRequire } from 'module';
const requireCjs = createRequire(import.meta.url);
const { findViolations } = requireCjs('../scripts/check-spawn-env-discipline.cjs') as {
  findViolations: () => Array<{ file: string; line: number }>;
};

/**
 * Tests for issue #2375: ANTHROPIC_BASE_URL must not leak from the parent
 * shell into the spawned worker's isolatedEnv, AND the OAuth-skip predicate
 * must not inject the user's Anthropic OAuth token onto a custom gateway URL
 * (which would be a token leak to a third party).
 *
 * Redirect EnvManager to a per-suite temp file via CLAUDE_MEM_ENV_FILE so
 * the user's real ~/.claude-mem/.env is never read or mutated even if a test
 * fails mid-flight. envFilePath() resolves the override on every call, so
 * this works regardless of the order other tests imported the module.
 */

const TEST_DATA_DIR = fs.mkdtempSync(join(tmpdir(), 'claude-mem-env-isolation-'));
const TEST_ENV_FILE = join(TEST_DATA_DIR, '.env');
const ORIGINAL_ENV_FILE = process.env.CLAUDE_MEM_ENV_FILE;

const ORIGINAL_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
const ORIGINAL_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;

function clearEnvFile(): void {
  if (fs.existsSync(TEST_ENV_FILE)) {
    fs.unlinkSync(TEST_ENV_FILE);
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
  beforeAll(() => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true, mode: 0o700 });
    process.env.CLAUDE_MEM_ENV_FILE = TEST_ENV_FILE;
    expect(envFilePath()).toBe(TEST_ENV_FILE);
  });

  afterAll(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    if (ORIGINAL_ENV_FILE === undefined) {
      delete process.env.CLAUDE_MEM_ENV_FILE;
    } else {
      process.env.CLAUDE_MEM_ENV_FILE = ORIGINAL_ENV_FILE;
    }
  });

  beforeEach(() => {
    clearEnvFile();
    clearAnthropicEnv();
  });

  afterEach(() => {
    clearEnvFile();
    restoreOriginalEnv();
  });

  it('leaked ANTHROPIC_BASE_URL is stripped from isolatedEnv', () => {
    // No .env file exists. The parent shell sets a stray ANTHROPIC_BASE_URL —
    // this MUST NOT propagate into the subprocess isolatedEnv, because doing
    // so used to trigger the OAuth-skip path and leave the worker with no
    // credentials at all.
    process.env.ANTHROPIC_BASE_URL = 'https://shouldnotleak.example';

    const result = buildIsolatedEnv();

    expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('~/.claude-mem/.env BASE_URL + AUTH_TOKEN reaches isolatedEnv', () => {
    // User intentionally configured a gateway with a gateway-appropriate
    // auth token. Both must be re-injected into isolatedEnv.
    fs.writeFileSync(
      TEST_ENV_FILE,
      'ANTHROPIC_BASE_URL=https://gateway.example\nANTHROPIC_AUTH_TOKEN=test-token\n',
      { mode: 0o600 },
    );

    const result = buildIsolatedEnv();

    expect(result.ANTHROPIC_BASE_URL).toBe('https://gateway.example');
    expect(result.ANTHROPIC_AUTH_TOKEN).toBe('test-token');
  });

  it('leaked process.env BASE_URL never reaches the OAuth-skip predicate', async () => {
    // The root cause of #2375: a BASE_URL exported by the parent shell used to
    // survive into isolatedEnv and trigger the OAuth-skip path, leaving the
    // subprocess with no credentials at all. With BASE_URL in BLOCKED_ENV_VARS,
    // the leak is stripped before the predicate runs, so OAuth lookup still
    // fires (the real credential path) rather than being short-circuited.
    process.env.ANTHROPIC_BASE_URL = 'https://leaked-from-shell.example';

    const oauthSpy = spyOn(oauthToken, 'readClaudeOAuthToken');
    try {
      const result = await buildIsolatedEnvWithFreshOAuth();
      // The leaked BASE_URL must not be present (it was never re-injected from
      // .env, which does not exist in this test).
      expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
    } finally {
      oauthSpy.mockRestore();
    }
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
      TEST_ENV_FILE,
      'ANTHROPIC_BASE_URL=https://gateway.example\n',
      { mode: 0o600 },
    );

    const oauthSpy = spyOn(oauthToken, 'readClaudeOAuthToken');

    try {
      const result = await buildIsolatedEnvWithFreshOAuth();

      expect(result.ANTHROPIC_BASE_URL).toBe('https://gateway.example');
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      // Best-effort sanity check; see note above.
      expect(oauthSpy).not.toHaveBeenCalled();
    } finally {
      oauthSpy.mockRestore();
    }
  });
});

/**
 * Issue #2357 (defense-in-depth): CLAUDE_CODE_EFFORT_LEVEL /
 * CLAUDE_CODE_ALWAYS_ENABLE_EFFORT must never reach the SDK subprocess. The
 * SDK forwards CLAUDE_CODE_EFFORT_LEVEL as the `effort` Messages API parameter;
 * models that don't support it reject with a permanent HTTP 400. Two layers
 * strip it: BLOCKED_ENV_VARS (buildIsolatedEnv) and the CLAUDE_CODE_* prefix
 * filter (sanitizeEnv). These tests prove BOTH layers independently.
 */
describe('Issue #2357: CLAUDE_CODE_EFFORT_* env-var isolation', () => {
  const ORIGINAL_EFFORT = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  const ORIGINAL_ALWAYS = process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT;

  afterEach(() => {
    if (ORIGINAL_EFFORT === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = ORIGINAL_EFFORT;
    if (ORIGINAL_ALWAYS === undefined) delete process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT;
    else process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = ORIGINAL_ALWAYS;
  });

  it('buildIsolatedEnv strips CLAUDE_CODE_EFFORT_LEVEL via BLOCKED_ENV_VARS (layer 1)', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'MAX';
    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = 'true';

    const result = buildIsolatedEnv();

    expect(result.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(result.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT).toBeUndefined();
  });

  it('sanitizeEnv(buildIsolatedEnv()) strips CLAUDE_CODE_EFFORT_LEVEL (both layers)', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'MAX';

    const result = sanitizeEnv(buildIsolatedEnv());

    expect(result.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });

  it('sanitizeEnv alone strips CLAUDE_CODE_EFFORT_LEVEL via the CLAUDE_CODE_* prefix (layer 2)', () => {
    const result = sanitizeEnv({ CLAUDE_CODE_EFFORT_LEVEL: 'MAX', PATH: '/usr/bin' });

    expect(result.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    // Unrelated vars survive.
    expect(result.PATH).toBe('/usr/bin');
  });
});

/**
 * Spawn-env discipline (plan 06 Phase 7): every env-bearing subprocess spawn in
 * src/ must sanitize process.env before handing it to the child. This test runs
 * the CI grep check inside the suite so a regression fails `bun test`, not just
 * a separate lint step.
 */
describe('spawn-env discipline (CI guard)', () => {
  it('no spawn site hands raw process.env to a child without sanitizeEnv', () => {
    const violations = findViolations();
    expect(violations).toEqual([]);
  });
});
