import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildTrialReadySettings,
  lastOAuthStartFailure,
  parseInstallerOAuthStartBody,
  parseTrialReadyBody,
  startInstallerOAuthPairing,
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

const validStartBody = {
  pairing_id: pairingId,
  secret: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  user_code: 'ABCD-2345',
  authorization_url: authorizationUrl,
  checkout_url: checkoutUrl,
  poll_interval: 3,
};

function runDeferredLoginChild(
  status: number,
  extraEnv: Record<string, string> = {},
  unsetEnv: string[] = [],
): { output: string; exitCode: number } {
  const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-installer-deferred-'));
  try {
    const script = `
      globalThis.fetch = async () => {
        console.log('__FETCH_CALLED__');
        return new Response(${JSON.stringify(status === 200 ? JSON.stringify(validStartBody) : '')}, {
          status: ${status},
          headers: { 'content-type': 'application/json' },
        });
      };
      const { offerDeferredLogin } = await import('./src/npx-cli/commands/install.ts');
      await offerDeferredLogin({ provider: 'claude', providerSource: 'default' }, 'test-version');
      console.log('__DEFERRED_DONE__');
    `;
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_MEM_TELEMETRY: '0',
      ...extraEnv,
    };
    for (const key of unsetEnv) delete env[key];
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      cwd: repoRoot,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = decoder.decode(result.stdout) + decoder.decode(result.stderr);
    return { output, exitCode: result.exitCode };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('installer OAuth start failure classification', () => {
  const realFetch = globalThis.fetch;
  const withFetch = async (impl: (init?: RequestInit) => Promise<Response>, opts?: { timeoutMs?: number }) => {
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => impl(init)) as typeof fetch;
    try {
      return await startInstallerOAuthPairing({ source: 'npx-installer-deferred', ...opts });
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  it('labels a non-2xx response http_error', async () => {
    expect(await withFetch(async () => new Response('', { status: 503 }))).toBeNull();
    expect(lastOAuthStartFailure()).toBe('http_error');
  });

  it('labels a 2xx with malformed JSON bad_body, not network', async () => {
    expect(await withFetch(async () => new Response('<html>not json</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }))).toBeNull();
    expect(lastOAuthStartFailure()).toBe('bad_body');
  });

  it('labels a 2xx whose JSON fails the pairing contract bad_body', async () => {
    expect(await withFetch(async () => Response.json({ pairing_id: 'nope' }))).toBeNull();
    expect(lastOAuthStartFailure()).toBe('bad_body');
  });

  it('labels a thrown fetch network and an abort timeout', async () => {
    expect(await withFetch(async () => { throw new TypeError('fetch failed'); })).toBeNull();
    expect(lastOAuthStartFailure()).toBe('network');

    expect(await withFetch((init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }), { timeoutMs: 20 })).toBeNull();
    expect(lastOAuthStartFailure()).toBe('timeout');
  });

  it('labels an abort that fires while the 2xx body is still streaming timeout, not bad_body', async () => {
    expect(await withFetch((init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"pairing_id":'));
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            controller.error(err);
          });
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }));
    }, { timeoutMs: 20 })).toBeNull();
    expect(lastOAuthStartFailure()).toBe('timeout');
  });

  it('clears the failure and sends the deferred source on success', async () => {
    const seen: string[] = [];
    const pairing = await withFetch(async (init) => {
      seen.push(String(init?.body));
      return Response.json(validStartBody);
    });
    expect(pairing?.pairingId).toBe(pairingId);
    expect(lastOAuthStartFailure()).toBeNull();
    expect(seen[0]).toContain('"source":"npx-installer-deferred"');
  });
});

describe('installer trial-ready contract', () => {
  it('parses an OAuth-only pairing without accepting an email or identity', () => {
    expect(parseInstallerOAuthStartBody({
      ...validStartBody,
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

  it('derives an absolute poll deadline from expires_in, clamped to 30 minutes', () => {
    const before = Date.now();
    const parsed = parseInstallerOAuthStartBody({ ...validStartBody, expires_in: 1800 });
    const after = Date.now();
    expect(parsed).toEqual(expect.objectContaining({ pairingId, expiresAt: expect.any(Number) }));
    expect(parsed!.expiresAt!).toBeGreaterThanOrEqual(before + 1800_000 - 2000);
    expect(parsed!.expiresAt!).toBeLessThanOrEqual(after + 1800_000);

    const clamped = parseInstallerOAuthStartBody({ ...validStartBody, expires_in: 7200 });
    expect(clamped!.expiresAt!).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000);
    expect(clamped!.expiresAt!).toBeGreaterThanOrEqual(before + 30 * 60 * 1000 - 2000);

    expect(parseInstallerOAuthStartBody(validStartBody)).not.toHaveProperty('expiresAt');
    expect(parseInstallerOAuthStartBody({ ...validStartBody, expires_in: 'soon' })).not.toHaveProperty('expiresAt');
    expect(parseInstallerOAuthStartBody({ ...validStartBody, expires_in: -5 })).not.toHaveProperty('expiresAt');
  });

  it('prints only the login-only link for a deferred non-interactive sign-in', () => {
    const { output, exitCode } = runDeferredLoginChild(200, {}, ['CI']);
    expect(exitCode, output).toBe(0);
    expect(output).toContain('__FETCH_CALLED__');
    expect(output).toContain('Sign-in link: https://cmem.ai/login?next=');
    expect(output).toContain('AGENT: show this link to the user');
    expect(output).not.toContain(checkoutUrl);
    expect(output).not.toContain('trial=7');
    expect(output).not.toContain('ABCD-2345');
    expect(output).not.toContain('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(output).toContain('__DEFERRED_DONE__');
  });

  it('stays silent and exits 0 when the deferred start request fails', () => {
    const { output, exitCode } = runDeferredLoginChild(503, {}, ['CI']);
    expect(exitCode, output).toBe(0);
    expect(output).toContain('__FETCH_CALLED__');
    expect(output).not.toContain('Sign-in link:');
    expect(output).not.toContain('AGENT:');
    expect(output).toContain('__DEFERRED_DONE__');
  });

  it('never contacts cmem.ai for the deferred offer under CI', () => {
    const { output, exitCode } = runDeferredLoginChild(200, { CI: '1' });
    expect(exitCode, output).toBe(0);
    expect(output).not.toContain('__FETCH_CALLED__');
    expect(output).not.toContain('Sign-in link:');
    expect(output).toContain('__DEFERRED_DONE__');
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
      cmem: 'CMEM Pro (30 Day Free Trial: Tokens for Observations + Real-Time Cloud Sync '
        + 'for Claude.ai, ChatGPT.com, anything that accepts an MCP Connector)',
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
  });

  it('does not ask for the billing acknowledgement in the terminal', () => {
    // It is a term of the charge and belongs on the checkout page, beside the
    // price and the card field — not asked twice, once before the user can see
    // what they are agreeing to.
    const source = readFileSync(join(repoRoot, 'src/npx-cli/commands/install.ts'), 'utf-8');
    expect(source).not.toContain('Confirm CMEM Pro Free Trial');
    expect(source).not.toContain('CMEM_TRIAL_ACKNOWLEDGEMENT');
  });

  it('requires OAuth before provider selection and contains no retired email path', () => {
    const source = readFileSync(join(repoRoot, 'src/npx-cli/commands/install.ts'), 'utf-8');
    const oauthIndex = source.indexOf('await requireInstallerOAuthLogin(version)');
    const providerIndex = source.indexOf('await promptProvider(options, oauthPairing, version)');
    expect(oauthIndex).toBeGreaterThan(-1);
    expect(providerIndex).toBeGreaterThan(oauthIndex);
    expect(source).toContain('p.multiselect<ProviderChoice>');
    expect(source).not.toContain('promptBrowserLogin');
    expect(source).not.toContain('CMEM_PRO_TRIAL_START_URL');
    expect(source).not.toContain('CLAUDE_MEM_ONLINE_OPTIN');
    expect(source).not.toContain('Your email:');
  });

  it('stops any respawned worker after provider settings are persisted', () => {
    const source = readFileSync(join(repoRoot, 'src/npx-cli/commands/install.ts'), 'utf-8');
    const providerIndex = source.indexOf('await promptProvider(options, oauthPairing, version)');
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
