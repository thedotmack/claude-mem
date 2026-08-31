import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildTrialReadySettings,
  parseInstallerOAuthStartBody,
  parseTrialReadyBody,
} from '../../src/npx-cli/commands/install';
import {
  buildProviderLabels,
  CMEM_PRO_BASE_URL,
  CMEM_PRO_MODEL,
  PROVIDER_PROMPT_MESSAGE,
} from '../../src/npx-cli/cmem-pro-costs';

const repoRoot = process.cwd();
const decoder = new TextDecoder();
const pairingId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const loginClaim = `/api/pro/trial/claim?pairing=${pairingId}&login_only=1`;
const authorizationUrl = `https://cmem.ai/login?next=${encodeURIComponent(loginClaim)}`;
const checkoutUrl = `https://cmem.ai/api/pro/trial/claim?pairing=${pairingId}&trial=7`;

function runCompletedPairingChild(body: Record<string, unknown>): {
  output: string;
  settings: Record<string, string>;
  settingsMode: number;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-installer-contract-'));
  try {
    const script = `
      globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(body))}, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      const { completeInstallerOAuthLogin } = await import('./src/npx-cli/commands/install.ts');
      const pairing = {
        pairingId: 'PAIRING_ID_MUST_NOT_LEAK',
        secret: 'PAIRING_SECRET_MUST_NOT_LEAK',
        pollIntervalMs: 1,
        userCode: 'ABCD-2345',
        authorizationUrl: 'https://cmem.ai/login',
        checkoutUrl: 'https://cmem.ai/api/pro/trial/claim?pairing=test&trial=7',
      };
      const result = await completeInstallerOAuthLogin(pairing, 'test-version');
      console.log('__PAIRING_RESULT__=' + JSON.stringify({ plan: pairing.delivered?.plan, ready: result }));
    `;
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDir,
        CLAUDE_MEM_TELEMETRY: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = decoder.decode(result.stdout) + decoder.decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    return {
      output,
      settings: JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf-8')),
      settingsMode: statSync(join(dataDir, 'settings.json')).mode & 0o777,
    };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('installer trial-ready contract', () => {
  it('parses an OAuth-only pairing without accepting an email or identity', () => {
    expect(parseInstallerOAuthStartBody({
      pairing_id: pairingId,
      secret: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      user_code: 'ABCD-2345',
      authorization_url: authorizationUrl,
      checkout_url: checkoutUrl,
      poll_interval: 3,
      email: 'must-not-be-read@example.com',
    })).toEqual({
      pairingId,
      secret: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      userCode: 'ABCD-2345',
      authorizationUrl,
      checkoutUrl,
      pollIntervalMs: 3000,
    });
  });

  it('rejects OAuth starts without both browser destinations', () => {
    expect(parseInstallerOAuthStartBody({
      pairing_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      secret: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      user_code: 'ABCD-2345',
      authorization_url: 'https://cmem.ai/login',
    })).toBeNull();
  });

  it('rejects browser destinations outside the configured CMEM origin', () => {
    expect(parseInstallerOAuthStartBody({
      pairing_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      secret: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      user_code: 'ABCD-2345',
      authorization_url: 'https://attacker.example/login',
      checkout_url: checkoutUrl,
    })).toBeNull();
  });

  it('rejects pairings whose login, offer, or device code does not match the response', () => {
    const valid = {
      pairing_id: pairingId,
      secret: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      user_code: 'ABCD-2345',
      authorization_url: authorizationUrl,
      checkout_url: checkoutUrl,
    };

    expect(parseInstallerOAuthStartBody({
      ...valid,
      authorization_url: `https://cmem.ai/login?next=${encodeURIComponent(`/api/pro/trial/claim?pairing=${pairingId}&trial=7`)}`,
    })).toBeNull();
    expect(parseInstallerOAuthStartBody({
      ...valid,
      checkout_url: `https://cmem.ai/api/pro/trial/claim?pairing=${'c'.repeat(32)}&trial=7`,
    })).toBeNull();
    expect(parseInstallerOAuthStartBody({ ...valid, checkout_url: `${checkoutUrl}&extra=1` })).toBeNull();
    expect(parseInstallerOAuthStartBody({ ...valid, user_code: 'INVALID1' })).toBeNull();
  });

  it('uses the exact two-option provider copy', () => {
    expect(buildProviderLabels()).toEqual({
      cmem: 'CMEM Pro (30 Day Free Trial: cloud sync, tokens included)',
      cmemHint: '',
      claude: 'Use your Anthropic Max Plan (no cloud sync, uses tokens for observations)',
      claudeHint: '',
    });
    expect(PROVIDER_PROMPT_MESSAGE).toBe('Select Provider:\n================');
  });

  it('keeps each provider description in the label so both rows always render it', () => {
    // clack's multiselect renders `hint` only for the focused/selected row, so a
    // description placed there would appear one row at a time. Both rows must
    // carry their own description at all times.
    const labels = buildProviderLabels();
    expect(labels.cmemHint).toBe('');
    expect(labels.claudeHint).toBe('');
    expect(labels.cmem).toContain('30 Day Free Trial');
    expect(labels.claude).toContain('no cloud sync');
    // Each row must stay on one line in an 80-column terminal, clack's row
    // prefix included, so neither description wraps into the other.
    for (const label of [labels.cmem, labels.claude]) {
      expect(label).not.toContain('\n');
      expect(label.length).toBeLessThan(74);
    }
  });

  it('does not ask for the billing acknowledgement in the terminal', () => {
    // It is a term of the charge and belongs on the checkout page, beside the
    // price and the card field — not asked twice, once before the user can see
    // what they are agreeing to.
    const source = readFileSync(join(repoRoot, 'src/npx-cli/commands/install.ts'), 'utf-8');
    expect(source).not.toContain('Confirm CMEM Pro Free Trial');
    expect(source).not.toContain('CMEM_TRIAL_ACKNOWLEDGEMENT');
  });

  it('resolves the provider choice before OAuth and contains no retired email path', () => {
    // Login is LAZY. The provider screen is free — no network, no account — so
    // it runs first, and OAuth is reached only once the resolved choice needs a
    // claude-mem account. Picking the Anthropic Max path opens no browser.
    const source = readFileSync(join(repoRoot, 'src/npx-cli/commands/install.ts'), 'utf-8');
    const choiceIndex = source.indexOf('await promptProviderChoice(options)');
    const gateIndex = source.indexOf('if (choiceNeedsAccount) {');
    const oauthIndex = source.indexOf('await requireInstallerOAuthLogin(version)');
    const applyIndex = source.indexOf('await promptProvider(providerChoice, oauthPairing, version)');
    expect(choiceIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeGreaterThan(choiceIndex);
    expect(oauthIndex).toBeGreaterThan(gateIndex);
    expect(applyIndex).toBeGreaterThan(oauthIndex);
    // The gate that makes login conditional on the CMEM branch.
    expect(source).toMatch(
      /const choiceNeedsAccount = options\.provider\s*\n\s*\? providerNeedsAccount\(options\.provider\)\s*\n\s*: providerChoice === 'cmem';/,
    );
    // promptProviderChoice takes no pairing and returns before any login.
    expect(source).toContain('async function promptProviderChoice(options: InstallOptions): Promise<ProviderChoice>');
    expect(source).toContain('p.multiselect<ProviderChoice>');
    expect(source).not.toContain('promptBrowserLogin');
    expect(source).not.toContain('CMEM_PRO_TRIAL_START_URL');
    expect(source).not.toContain('CLAUDE_MEM_ONLINE_OPTIN');
    expect(source).not.toContain('Your email:');
  });

  it('stops any respawned worker after provider settings are persisted', () => {
    const source = readFileSync(join(repoRoot, 'src/npx-cli/commands/install.ts'), 'utf-8');
    const providerIndex = source.indexOf('await promptProvider(providerChoice, oauthPairing, version)');
    const cutoverIndex = source.indexOf("'provider-cutover'", providerIndex);
    const workerStartIndex = source.indexOf('workerStartResult = await ensureWorkerStarted', cutoverIndex);
    expect(providerIndex).toBeGreaterThan(-1);
    expect(cutoverIndex).toBeGreaterThan(providerIndex);
    expect(workerStartIndex).toBeGreaterThan(cutoverIndex);
  });

  it('normalizes the current poll response without changing delivered credentials', () => {
    const ready = parseTrialReadyBody({
      status: 'ready',
      user_id: 'user_123',
      setup_token: 'setup_secret',
      hub_url: 'https://sync.cmem.ai',
      memory_key: 'cm_pro_memory_secret',
      memory_base_url: 'https://cmem.ai/api/inference/v1',
      memory_model: 'cmem-observer-v2',
      plan: 'pro',
      trial: { ends_at: '2026-09-02T12:00:00.000Z' },
    });

    expect(ready).toEqual({
      userId: 'user_123',
      setupToken: 'setup_secret',
      hubUrl: 'https://sync.cmem.ai',
      memoryKey: 'cm_pro_memory_secret',
      memoryBaseUrl: 'https://cmem.ai/api/inference/v1',
      memoryModel: 'cmem-observer-v2',
      plan: 'pro',
      trialEndsAt: '2026-09-02T12:00:00.000Z',
    });
  });

  it('supports the legacy response by using the setup token and gateway defaults', () => {
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'legacy_user',
      setup_token: 'legacy_one_shot_token',
      hub_url: 'https://legacy-sync.cmem.ai',
    })).toEqual({
      userId: 'legacy_user',
      setupToken: 'legacy_one_shot_token',
      hubUrl: 'https://legacy-sync.cmem.ai',
      memoryKey: 'legacy_one_shot_token',
      memoryBaseUrl: CMEM_PRO_BASE_URL,
      memoryModel: CMEM_PRO_MODEL,
      plan: 'trial',
      trialEndsAt: null,
    });
  });

  it('rejects malformed and non-ready poll responses', () => {
    expect(parseTrialReadyBody(null)).toBeNull();
    expect(parseTrialReadyBody({ status: 'pending' })).toBeNull();
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'user_123',
      setup_token: 'setup_secret',
    })).toBeNull();
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 123,
      setup_token: 'setup_secret',
      hub_url: 'https://sync.cmem.ai',
    })).toBeNull();
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'user_123',
      setup_token: '   ',
      hub_url: 'https://sync.cmem.ai',
    })).toBeNull();
  });

  it('falls back safely for optional fields from a partially upgraded server', () => {
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'user_123',
      setup_token: 'setup_secret',
      hub_url: 'https://sync.cmem.ai',
      memory_key: '',
      memory_base_url: '',
      memory_model: '',
      plan: 'future-plan',
      trial: { ends_at: 123 },
    })).toEqual({
      userId: 'user_123',
      setupToken: 'setup_secret',
      hubUrl: 'https://sync.cmem.ai',
      memoryKey: 'setup_secret',
      memoryBaseUrl: CMEM_PRO_BASE_URL,
      memoryModel: CMEM_PRO_MODEL,
      plan: 'trial',
      trialEndsAt: null,
    });
  });

  it('stages one-shot credentials atomically without choosing a provider', () => {
    const settings = buildTrialReadySettings({
      userId: 'user_123',
      setupToken: 'setup_secret',
      hubUrl: 'https://sync.cmem.ai',
      memoryKey: 'cm_pro_memory_secret',
      memoryBaseUrl: 'https://cmem.ai/api/inference/v1',
      memoryModel: 'cmem-observer',
      plan: 'none',
      trialEndsAt: null,
    }, 'test-device');

    expect(settings).toEqual({
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'setup_secret',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user_123',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.cmem.ai',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'test-device',
      CLAUDE_MEM_PRO_TRIAL_STATE: 'active',
      CLAUDE_MEM_PRO_TRIAL_ENDS_AT: '',
      CLAUDE_MEM_PRO_PLAN: 'none',
      CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_memory_secret',
      CLAUDE_MEM_PRO_MEMORY_BASE_URL: 'https://cmem.ai/api/inference/v1',
      CLAUDE_MEM_PRO_MEMORY_MODEL: 'cmem-observer',
      CLAUDE_MEM_PRO_FALLBACK_AT: '',
    });
    expect(settings).not.toHaveProperty('CLAUDE_MEM_PROVIDER');
    expect(settings).not.toHaveProperty('CLAUDE_MEM_OPENROUTER_API_KEY');
    expect(Object.values(settings).filter((value) => value === 'cm_pro_memory_secret')).toHaveLength(1);
  });

  it('persists the current ready response without printing delivered secrets', () => {
    const { output, settings, settingsMode } = runCompletedPairingChild({
      status: 'ready',
      user_id: 'user_123',
      setup_token: 'SETUP_TOKEN_MUST_NOT_LEAK',
      hub_url: 'https://sync.cmem.ai',
      memory_key: 'MEMORY_KEY_MUST_NOT_LEAK',
      memory_base_url: 'https://cmem.ai/api/inference/v1',
      memory_model: 'cmem-observer',
      plan: 'none',
    });

    expect(output).toContain('__PAIRING_RESULT__={"plan":"none","ready":true}');
    expect(output).not.toContain('PAIRING_ID_MUST_NOT_LEAK');
    expect(output).not.toContain('PAIRING_SECRET_MUST_NOT_LEAK');
    expect(output).not.toContain('SETUP_TOKEN_MUST_NOT_LEAK');
    expect(output).not.toContain('MEMORY_KEY_MUST_NOT_LEAK');
    expect(settings.CLAUDE_MEM_PRO_MEMORY_KEY).toBe('MEMORY_KEY_MUST_NOT_LEAK');
    expect(settings).not.toHaveProperty('CLAUDE_MEM_PROVIDER');
    expect(settings).not.toHaveProperty('CLAUDE_MEM_OPENROUTER_API_KEY');
    expect(settingsMode).toBe(0o600);
  });

  it('persists the legacy ready response with its setup token as the memory credential', () => {
    const { output, settings } = runCompletedPairingChild({
      status: 'ready',
      user_id: 'legacy_user',
      setup_token: 'LEGACY_TOKEN_MUST_NOT_LEAK',
      hub_url: 'https://legacy-sync.cmem.ai',
    });

    expect(output).toContain('__PAIRING_RESULT__={"plan":"trial","ready":true}');
    expect(output).not.toContain('LEGACY_TOKEN_MUST_NOT_LEAK');
    expect(settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN).toBe('LEGACY_TOKEN_MUST_NOT_LEAK');
    expect(settings.CLAUDE_MEM_PRO_MEMORY_KEY).toBe('LEGACY_TOKEN_MUST_NOT_LEAK');
    expect(settings.CLAUDE_MEM_PRO_MEMORY_BASE_URL).toBe(CMEM_PRO_BASE_URL);
    expect(settings.CLAUDE_MEM_PRO_MEMORY_MODEL).toBe(CMEM_PRO_MODEL);
  });

  it('treats Ctrl+C during required OAuth polling as an incomplete login', () => {
    const script = `
      globalThis.fetch = async () => new Response(JSON.stringify({ stage: 'awaiting_login' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
      const { completeInstallerOAuthLogin } = await import('./src/npx-cli/commands/install.ts');
      setTimeout(() => process.emit('SIGINT'), 20);
      const result = await completeInstallerOAuthLogin({
        pairingId: 'PAIRING_ID_MUST_NOT_LEAK',
        secret: 'PAIRING_SECRET_MUST_NOT_LEAK',
        pollIntervalMs: 1000,
        userCode: 'ABCD-2345',
        authorizationUrl: 'https://cmem.ai/login',
        checkoutUrl: 'https://cmem.ai/api/pro/trial/claim?pairing=test&trial=7',
      }, 'test-version');
      console.log('__CANCEL_RESULT__=' + String(result));
    `;
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      cwd: repoRoot,
      env: { ...process.env, CLAUDE_MEM_TELEMETRY: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = decoder.decode(result.stdout) + decoder.decode(result.stderr);

    expect(result.exitCode, output).toBe(0);
    expect(output).toContain('__CANCEL_RESULT__=false');
    expect(output).not.toContain('continues installation');
    expect(output).not.toContain('PAIRING_ID_MUST_NOT_LEAK');
    expect(output).not.toContain('PAIRING_SECRET_MUST_NOT_LEAK');
  });
});
