import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { claudeJsonPath, detectObservedBilling } from '../../src/shared/observed-billing.js';

// A realistic key shape; only its last 20 chars are ever compared.
const API_KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBB';
const API_KEY_SUFFIX = API_KEY.slice(-20);

let tempDir: string;
let claudeJsonFile: string;

function writeClaudeJson(contents: unknown): void {
  writeFileSync(claudeJsonFile, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'observed-billing-'));
  claudeJsonFile = join(tempDir, '.claude.json');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('claudeJsonPath', () => {
  it('honors CLAUDE_CONFIG_DIR', () => {
    expect(claudeJsonPath({ CLAUDE_CONFIG_DIR: '/custom/cfg' })).toBe(join('/custom/cfg', '.claude.json'));
  });

  it('falls back to the home directory', () => {
    expect(claudeJsonPath({})).toMatch(/\.claude\.json$/);
    expect(claudeJsonPath({})).not.toContain('/custom/cfg');
  });
});

describe('detectObservedBilling — cloud providers', () => {
  it('reports bedrock / vertex / foundry from their env flags', () => {
    writeClaudeJson({ oauthAccount: { organizationType: 'claude_max' } });
    expect(detectObservedBilling({ CLAUDE_CODE_USE_BEDROCK: '1' }, claudeJsonFile)).toBe('bedrock');
    expect(detectObservedBilling({ CLAUDE_CODE_USE_VERTEX: 'true' }, claudeJsonFile)).toBe('vertex');
    expect(detectObservedBilling({ CLAUDE_CODE_USE_FOUNDRY: 'yes' }, claudeJsonFile)).toBe('foundry');
  });

  it('ignores "0" / "false" / empty provider flags', () => {
    writeClaudeJson({ oauthAccount: { organizationType: 'claude_max' } });
    expect(
      detectObservedBilling(
        { CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: 'FALSE', CLAUDE_CODE_USE_FOUNDRY: '' },
        claudeJsonFile,
      ),
    ).toBe('max');
  });
});

describe('detectObservedBilling — API key', () => {
  it('reports api_key when a key is set and there is no account', () => {
    expect(detectObservedBilling({ ANTHROPIC_API_KEY: API_KEY }, claudeJsonFile)).toBe('api_key');
  });

  it('accepts ANTHROPIC_AUTH_TOKEN as the key source', () => {
    expect(detectObservedBilling({ ANTHROPIC_AUTH_TOKEN: API_KEY }, claudeJsonFile)).toBe('api_key');
  });

  it('falls back to the account tier when the key is set but not approved', () => {
    writeClaudeJson({
      oauthAccount: { organizationType: 'claude_max' },
      customApiKeyResponses: { approved: ['00000000000000000000'] },
    });
    expect(detectObservedBilling({ ANTHROPIC_API_KEY: API_KEY }, claudeJsonFile)).toBe('max');
  });

  it('reports api_key when the key suffix is in customApiKeyResponses.approved', () => {
    writeClaudeJson({
      oauthAccount: { organizationType: 'claude_max' },
      customApiKeyResponses: { approved: [API_KEY_SUFFIX] },
    });
    expect(detectObservedBilling({ ANTHROPIC_API_KEY: API_KEY }, claudeJsonFile)).toBe('api_key');
  });
});

describe('detectObservedBilling — subscription account', () => {
  it('strips the claude_ prefix from organizationType', () => {
    writeClaudeJson({ oauthAccount: { organizationType: 'claude_max' } });
    expect(detectObservedBilling({}, claudeJsonFile)).toBe('max');

    writeClaudeJson({ oauthAccount: { organizationType: 'claude_pro' } });
    expect(detectObservedBilling({}, claudeJsonFile)).toBe('pro');
  });

  it('recognizes every known tier: max / pro / team / enterprise', () => {
    for (const tier of ['max', 'pro', 'team', 'enterprise']) {
      writeClaudeJson({ oauthAccount: { organizationType: `claude_${tier}` } });
      expect(detectObservedBilling({}, claudeJsonFile)).toBe(tier);
    }
  });

  it('collapses an unknown organizationType to "subscription" (closed set)', () => {
    writeClaudeJson({ oauthAccount: { organizationType: 'Weird Tier/With Spaces' } });
    expect(detectObservedBilling({}, claudeJsonFile)).toBe('subscription');

    // Well-formed but not in the closed set — must not widen the enum.
    writeClaudeJson({ oauthAccount: { organizationType: 'claude_startup' } });
    expect(detectObservedBilling({}, claudeJsonFile)).toBe('subscription');
  });

  it('ignores token-shaped fields on oauthAccount and still reports the tier', () => {
    writeClaudeJson({
      oauthAccount: {
        organizationType: 'claude_team',
        accountUuid: 'acct-uuid',
        emailAddress: 'someone@example.com',
        accessToken: 'sk-ant-oat01-secret',
      },
    });
    expect(detectObservedBilling({}, claudeJsonFile)).toBe('team');
  });

  it('reports subscription for an account without organizationType', () => {
    writeClaudeJson({ oauthAccount: {} });
    expect(detectObservedBilling({}, claudeJsonFile)).toBe('subscription');
  });

  it('reports subscription when only CLAUDE_CODE_OAUTH_TOKEN is set', () => {
    expect(detectObservedBilling({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xyz' }, claudeJsonFile)).toBe('subscription');
  });
});

describe('detectObservedBilling — unknown', () => {
  it('reports unknown when nothing is set and the file is missing', () => {
    expect(detectObservedBilling({}, claudeJsonFile)).toBe('unknown');
  });

  it('reports unknown when the file exists but has no account', () => {
    writeClaudeJson({ oauthAccount: null, customApiKeyResponses: { approved: [] } });
    expect(detectObservedBilling({}, claudeJsonFile)).toBe('unknown');
  });

  it('treats a corrupt .claude.json as no account instead of throwing', () => {
    writeClaudeJson('{ not json');
    expect(() => detectObservedBilling({}, claudeJsonFile)).not.toThrow();
    expect(detectObservedBilling({}, claudeJsonFile)).toBe('unknown');
    expect(detectObservedBilling({ ANTHROPIC_API_KEY: API_KEY }, claudeJsonFile)).toBe('api_key');
  });
});
