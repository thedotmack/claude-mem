import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { INSTALL_RUN_BY_AUTO_UPDATE_ENV } from '../../src/shared/auto-update-install-run';
import { CLOUD_SYNC_SETUP_CONTRACT, SETUP_CLOUD_SYNC_OFFERS, type SetupCloudSyncOffer } from '../../src/shared/setup-funnel';
import {
  buildTrialReadySettings,
  lastOAuthStartErrorMessage,
  lastOAuthStartFailure,
  parseInstallerOAuthStartBody,
  parseTrialReadyBody,
  startInstallerOAuthPairing,
} from '../../src/npx-cli/commands/install';
import {
  buildProviderLabels,
  CMEM_PRO_BASE_URL,
  CMEM_PRO_MODEL,
} from '../../src/npx-cli/cmem-pro-costs';

const repoRoot = process.cwd();
const decoder = new TextDecoder();
const pairingId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const loginClaim = `/api/pro/trial/claim?pairing=${pairingId}&login_only=1`;
const authorizationUrl = `https://cmem.ai/login?next=${encodeURIComponent(loginClaim)}`;
const checkoutUrl = `https://cmem.ai/api/pro/trial/claim?pairing=${pairingId}&trial=7`;

function runCompletedPairingChild(body: Record<string, unknown>, initialSettings?: Record<string, string>, cloudSyncOffer?: SetupCloudSyncOffer, shareWorkView?: true, env?: Record<string, string>): {
  output: string;
  settings: Record<string, string>;
  settingsMode: number;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-installer-contract-'));
  try {
    if (initialSettings) writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(initialSettings, null, 2));
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
        cloudSyncOffer: ${JSON.stringify(cloudSyncOffer)},
        shareWorkView: ${JSON.stringify(shareWorkView)},
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
        ...env,
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

function cloudStartBody(offer: SetupCloudSyncOffer, flow?: string) {
  const intent = { pairing: pairingId, product: 'cloud_sync', offer, ...(flow ? { setup_flow_id: flow } : {}) };
  const login = `/api/pro/trial/claim?${new URLSearchParams({ ...intent, login_only: '1' })}`;
  return {
    ...validStartBody,
    authorization_url: `https://cmem.ai/login?next=${encodeURIComponent(login)}`,
    checkout_url: `https://cmem.ai/api/pro/trial/claim?${new URLSearchParams(intent)}`,
    cloud_sync_offer: offer,
    cloud_sync_contract: CLOUD_SYNC_SETUP_CONTRACT,
  };
}

describe('standalone Cloud Sync installer contract', () => {
  for (const offer of SETUP_CLOUD_SYNC_OFFERS) {
    it(`round-trips ${offer}, including its setup episode`, () => {
      const flow = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const body = cloudStartBody(offer, flow);
      const pairing = parseInstallerOAuthStartBody(body, flow, offer);
      expect(pairing?.cloudSyncOffer).toBe(offer);
      expect(pairing?.checkoutUrl).toBe(body.checkout_url);
      expect(pairing?.authorizationUrl).toBe(body.authorization_url);
      expect(parseInstallerOAuthStartBody(body, undefined, offer)).toBeNull();
    });
  }

  it('accepts a login-only continuation when the pairing still confirms Cloud intent', () => {
    const body = { ...cloudStartBody('cloud_sync_monthly'), authorization_url: authorizationUrl };
    expect(parseInstallerOAuthStartBody(body, undefined, 'cloud_sync_monthly')?.cloudSyncOffer).toBe('cloud_sync_monthly');
  });

  it('refuses legacy bundles, mismatched offers, changed versions, and extra checkout purchase parameters', () => {
    const body = cloudStartBody('cloud_sync_monthly');
    const refused = [
      validStartBody,
      { ...body, cloud_sync_offer: 'cloud_sync_annual' },
      { ...body, cloud_sync_contract: undefined },
      { ...body, cloud_sync_contract: 2 },
      { ...body, checkout_url: checkoutUrl },
      { ...body, checkout_url: body.checkout_url.replace('cloud_sync_monthly', 'cloud_sync_annual') },
      { ...body, checkout_url: `${body.checkout_url}&trial=30` },
      { ...body, checkout_url: `${body.checkout_url}&offer=cloud_sync_monthly` },
      { ...body, checkout_url: `${body.checkout_url}&price=pro` },
      { ...body, authorization_url: `https://cmem.ai/login?next=${encodeURIComponent(`${loginClaim}&product=cloud_sync&offer=cloud_sync_annual`)}` },
    ];
    for (const response of refused) expect(parseInstallerOAuthStartBody(response, undefined, 'cloud_sync_monthly')).toBeNull();
    // A saved legacy request cannot silently become a new Cloud purchase either.
    expect(parseInstallerOAuthStartBody(body)).toBeNull();
    expect(parseInstallerOAuthStartBody(validStartBody)?.checkoutUrl).toBe(checkoutUrl);
  });

  it('enables the board only for an explicitly selected and approved compatible Cloud Sync device', () => {
    const ready = { status: 'ready', user_id: 'fixture-owner', setup_token: 'fixture-setup-token', plan: 'cloud_sync', hub_url: 'https://sync.cmem.ai' };
    const flag = 'CLAUDE_MEM_WORK_VIEW_SHARED_STATE';
    const offer = 'cloud_sync_monthly';
    expect(runCompletedPairingChild(ready, {}, offer, true).settings[flag]).toBe('true');
    expect(runCompletedPairingChild(ready, { [flag]: '' }, offer, true).settings[flag]).toBe('true');
    expect(runCompletedPairingChild(ready, { [flag]: 'false' }, offer, true).settings[flag]).toBe('false');
    expect(runCompletedPairingChild(ready, {}, offer, true, { [flag]: 'false' }).settings[flag]).toBeUndefined();
    expect(runCompletedPairingChild(ready, {}, offer).settings[flag]).toBeUndefined();
    expect(runCompletedPairingChild(ready, {}, undefined, true).settings[flag]).toBeUndefined();
    expect(runCompletedPairingChild({ ...ready, hub_url: 'https://custom-hub.test' }, {}, offer, true).settings[flag]).toBeUndefined();
    expect(runCompletedPairingChild(ready, {}, offer, true, { CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://custom-hub.test' }).settings[flag]).toBeUndefined();
  });

  it('persists only Cloud credentials and keeps the configured observer and its credentials', () => {
    const initial = {
      CLAUDE_MEM_PROVIDER: 'gemini',
      CLAUDE_MEM_GEMINI_API_KEY: 'own-provider-key',
      CLAUDE_MEM_PRO_MEMORY_KEY: 'previous-staged-hosted-key',
      CLAUDE_MEM_PRO_TRIAL_STATE: 'expired',
    };
    const { output, settings, settingsMode } = runCompletedPairingChild({
      status: 'ready', user_id: 'cloud_user', setup_token: 'CLOUD_TOKEN_MUST_NOT_LEAK', hub_url: 'https://sync.cmem.ai', plan: 'cloud_sync',
    }, initial, 'cloud_sync_monthly');
    expect(output).toContain('__PAIRING_RESULT__={"plan":"cloud_sync","ready":true}');
    expect(output).not.toContain('CLOUD_TOKEN_MUST_NOT_LEAK');
    expect(settings).toEqual({
      ...initial,
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'CLOUD_TOKEN_MUST_NOT_LEAK',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'cloud_user',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.cmem.ai',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: expect.any(String),
    });
    // Windows has no POSIX permission bits: stat reports 0o666 for a writable file.
    if (process.platform !== 'win32') expect(settingsMode).toBe(0o600);
  });

  it('connects Cloud Sync for a Pro account on a Cloud-only pairing and never writes its hosted memory credentials', () => {
    // A Pro account with no Pro settings on this machine (a complimentary plan, or a new computer) only sees the
    // Cloud Sync offers, so its sign-in arrives on a Cloud-only pairing. Pro includes Cloud Sync: keep the sync
    // connection, drop the bundled observer credentials, and keep the configured provider.
    const initial = { CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_MODEL: 'haiku' };
    for (const extra of [
      { plan: 'pro' },
      { plan: 'pro', memory_key: 'HOSTED_MEMORY_KEY_MUST_NOT_BE_WRITTEN', memory_base_url: 'https://cmem.ai/api/inference/v1' },
      { plan: 'trial', memory_key: 'HOSTED_MEMORY_KEY_MUST_NOT_BE_WRITTEN' },
    ]) {
      const { output, settings, settingsMode } = runCompletedPairingChild({
        status: 'ready', user_id: 'pro_user', setup_token: 'PRO_SYNC_TOKEN_MUST_NOT_LEAK', hub_url: 'https://sync.cmem.ai', ...extra,
      }, initial, 'cloud_sync_monthly');
      expect(output).toContain(`__PAIRING_RESULT__={"plan":"${extra.plan}","ready":true}`);
      expect(output).not.toContain('PRO_SYNC_TOKEN_MUST_NOT_LEAK');
      expect(output).not.toContain('HOSTED_MEMORY_KEY_MUST_NOT_BE_WRITTEN');
      expect(settings).toEqual({
        ...initial,
        CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'PRO_SYNC_TOKEN_MUST_NOT_LEAK',
        CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'pro_user',
        CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.cmem.ai',
        CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '',
        CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: expect.any(String),
      });
      if (process.platform !== 'win32') expect(settingsMode).toBe(0o600);
    }
  });

  it('finishes the browser checkout wait when a Pro account answers a Cloud-only pairing', () => {
    // The browser funnel's checkout waits in completeCmemTrialPairing (the enrollment poll). Refusing a Pro delivery
    // here left the checkout unfinished after a successful sign-in.
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-installer-enrollment-'));
    try {
      const initial = { CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_MODEL: 'haiku' };
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(initial, null, 2));
      const body = { status: 'ready', user_id: 'pro_user', setup_token: 'PRO_SYNC_TOKEN_MUST_NOT_LEAK', hub_url: 'https://sync.cmem.ai', plan: 'pro', memory_key: 'HOSTED_MEMORY_KEY_MUST_NOT_BE_WRITTEN' };
      const script = `
        globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(body))}, { status: 200, headers: { 'content-type': 'application/json' } });
        const { completeCmemTrialPairing } = await import('./src/npx-cli/commands/install.ts');
        const pairing = { pairingId: 'P', secret: 'S', pollIntervalMs: 1, userCode: 'ABCD-2345', authorizationUrl: 'https://cmem.ai/login', checkoutUrl: 'https://cmem.ai/checkout', cloudSyncOffer: 'cloud_sync_monthly' };
        const delivered = await completeCmemTrialPairing(pairing, 'test-version', { opened: true });
        console.log('__ENROLLMENT__=' + JSON.stringify({ plan: delivered?.plan, memory: delivered?.memory ?? null }));
      `;
      const run = Bun.spawnSync([process.execPath, '--eval', script], {
        cwd: repoRoot, env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_MEM_TELEMETRY: '0' }, stdout: 'pipe', stderr: 'pipe',
      });
      const output = decoder.decode(run.stdout) + decoder.decode(run.stderr);
      expect(run.exitCode, output).toBe(0);
      expect(output).toContain('__ENROLLMENT__={"plan":"pro","memory":null}');
      expect(output).toContain('Cloud Sync connected through your CMEM Pro plan.');
      expect(output).not.toMatch(/CMEM Pro .*active\./);
      expect(output).not.toContain('HOSTED_MEMORY_KEY_MUST_NOT_BE_WRITTEN');
      const settings = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf-8'));
      expect(settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN).toBe('PRO_SYNC_TOKEN_MUST_NOT_LEAK');
      expect(settings.CLAUDE_MEM_PROVIDER).toBe('claude');
      expect(Object.keys(settings).some(key => key.startsWith('CLAUDE_MEM_PRO_'))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects bundled or hosted credential delivery for a Cloud-only pairing before writing settings', () => {
    const initial = { CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_MODEL: 'haiku' };
    for (const extra of [{ plan: 'none' }, { plan: 'teambrain_seat' }, { plan: 'cloud_sync', memory_key: 'UNEXPECTED_MEMORY_KEY', memory_base_url: 'https://cmem.ai/api/inference/v1' }]) {
      const { output, settings } = runCompletedPairingChild({
        status: 'ready', user_id: 'cloud_user', setup_token: 'UNEXPECTED_SETUP_TOKEN', hub_url: 'https://sync.cmem.ai', ...extra,
      }, initial, 'cloud_sync_annual');
      expect(output).toContain('__PAIRING_RESULT__={"ready":false}');
      expect(output).toContain('Your existing memory provider was kept.');
      expect(output).not.toContain('UNEXPECTED_MEMORY_KEY');
      expect(output).not.toContain('UNEXPECTED_SETUP_TOKEN');
      expect(settings).toEqual(initial);
    }
  });
});

/** Project-local scratch (gitignored) for the auto-update cases below, never the system temp folder. */
const scratchRoot = join(repoRoot, '.scratch', 'test-runs');

describe('installer OAuth start failure classification', () => {
  const realFetch = globalThis.fetch;
  const withFetch = async (
    impl: (init?: RequestInit, url?: string) => Promise<Response>,
    opts: { timeoutMs?: number; credentials?: Record<string, unknown>; cloudSyncOffer?: SetupCloudSyncOffer } = {},
  ) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-oauth-start-'));
    const previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    if (opts.credentials) writeFileSync(join(dataDir, 'intent-install.json'), JSON.stringify(opts.credentials), { mode: 0o600 });
    globalThis.fetch = ((url: unknown, init?: RequestInit) => impl(init, String(url))) as typeof fetch;
    try {
      return await startInstallerOAuthPairing({ timeoutMs: opts.timeoutMs, cloudSyncOffer: opts.cloudSyncOffer });
    } finally {
      globalThis.fetch = realFetch;
      if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
      else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  };

  it('labels a non-2xx response http_error', async () => {
    expect(await withFetch(async () => new Response('', { status: 503 }))).toBeNull();
    expect(lastOAuthStartFailure()).toBe('http_error');
  });

  it('sends the explicit Cloud offer and contract version and fails closed against an older server', async () => {
    const pairing = await withFetch(async init => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ cloud_sync_offer: 'cloud_sync_annual', cloud_sync_contract: 1 });
      return Response.json(cloudStartBody('cloud_sync_annual'));
    }, { cloudSyncOffer: 'cloud_sync_annual' });
    expect(pairing?.cloudSyncOffer).toBe('cloud_sync_annual');
    expect(await withFetch(async () => Response.json(validStartBody), { cloudSyncOffer: 'cloud_sync_monthly' })).toBeNull();
    expect(lastOAuthStartFailure()).toBe('bad_body');
    expect(lastOAuthStartErrorMessage()).toContain('did not confirm the selected standalone Cloud Sync offer');
  });

  it('falls back to the HTTP status when a non-2xx body carries no message (#5493)', async () => {
    expect(await withFetch(async () => new Response('Too Many Requests', { status: 429 }))).toBeNull();
    expect(lastOAuthStartFailure()).toBe('http_error');
    // #5493 — a refusal used to surface as "run again when cmem.ai is
    // reachable", sending the user hunting for a network problem.
    expect(lastOAuthStartErrorMessage()).toBe('cmem.ai answered HTTP 429');
  });

  it('retains the server error message for the caller to show', async () => {
    expect(await withFetch(async () => Response.json({
      error: 'intent_credentials_invalid', message: 'This installation credential was not accepted.',
    }, { status: 401 }))).toBeNull();
    expect(lastOAuthStartFailure()).toBe('http_error');
    expect(lastOAuthStartErrorMessage()).toBe('This installation credential was not accepted.');
  });

  it('sends persisted install headers only to the existing OAuth start endpoint', async () => {
    const credentials = { install_id: '1'.repeat(32), intent_token: '2'.repeat(64) };
    const requests: string[] = [];
    const pairing = await withFetch(async (init, url) => {
      requests.push(url!);
      expect(new Headers(init?.headers).get('X-Intent-Install-Id')).toBe(credentials.install_id);
      expect(new Headers(init?.headers).get('X-Intent-Token')).toBe(credentials.intent_token);
      return Response.json(validStartBody);
    }, { credentials });
    expect(pairing?.pairingId).toBe(pairingId);
    expect(requests).toEqual(['https://cmem.ai/api/installer/oauth/start']);
  });

  it('keeps OAuth start compatible without an install identity and never issues one', async () => {
    const requests: string[] = [];
    const pairing = await withFetch(async (init, url) => {
      requests.push(url!);
      expect(new Headers(init?.headers).has('X-Intent-Install-Id')).toBe(false);
      expect(new Headers(init?.headers).has('X-Intent-Token')).toBe(false);
      return Response.json(validStartBody);
    });
    expect(pairing?.pairingId).toBe(pairingId);
    expect(requests).toEqual(['https://cmem.ai/api/installer/oauth/start']);
  });

  it('refuses an invalid explicit install identity before any network request', async () => {
    let requests = 0;
    expect(await withFetch(async () => {
      requests++;
      return Response.json(validStartBody);
    }, { credentials: { install_id: '1'.repeat(32) } })).toBeNull();
    expect(requests).toBe(0);
    expect(lastOAuthStartFailure()).toBe('credentials');
    expect(lastOAuthStartErrorMessage()).toContain('Hosted intent credentials are invalid');
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

  it('clears the failure and sends the installer source on success', async () => {
    const seen: string[] = [];
    const pairing = await withFetch(async (init) => {
      seen.push(String(init?.body));
      return Response.json(validStartBody);
    });
    expect(pairing?.pairingId).toBe(pairingId);
    expect(lastOAuthStartFailure()).toBeNull();
    expect(lastOAuthStartErrorMessage()).toBeNull();
    expect(seen[0]).toContain('"source":"npx-installer"');
  });
});

describe('installer OAuth start with a setup episode (#5493)', () => {
  const flow = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  // The exact shape cmem.ai's buildInstallerOAuthUrls returns when the start
  // request carried setup_flow_id: the episode is copied into both claim URLs.
  function echoedStartBody(echoedFlow: string, extra: Record<string, string> = {}) {
    const login = `/api/pro/trial/claim?${new URLSearchParams({ pairing: pairingId, setup_flow_id: echoedFlow, login_only: '1', ...extra })}`;
    const checkout = `https://cmem.ai/api/pro/trial/claim?${new URLSearchParams({ pairing: pairingId, setup_flow_id: echoedFlow, trial: '30', ...extra })}`;
    return { ...validStartBody, authorization_url: `https://cmem.ai/login?next=${encodeURIComponent(login)}`, checkout_url: checkout };
  }

  it('accepts the episode it sent echoed in both claim URLs and keeps it in the links', () => {
    const body = echoedStartBody(flow);
    const parsed = parseInstallerOAuthStartBody(body, flow);
    expect(parsed).not.toBeNull();
    expect(parsed?.authorizationUrl).toBe(body.authorization_url);
    expect(parsed?.checkoutUrl).toBe(body.checkout_url);
  });

  it('rejects an episode it did not send, a different episode, or any other extra parameter', () => {
    expect(parseInstallerOAuthStartBody(echoedStartBody(flow))).toBeNull();
    expect(parseInstallerOAuthStartBody(echoedStartBody(flow), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBeNull();
    expect(parseInstallerOAuthStartBody(echoedStartBody(flow, { redirect: 'https://evil.example' }), flow)).toBeNull();
  });

  it('still accepts a server that leaves the episode out', () => {
    expect(parseInstallerOAuthStartBody(validStartBody, flow)).not.toBeNull();
  });

  it('completes a start that sent an episode instead of failing bad_body', async () => {
    const previousFetch = globalThis.fetch;
    const previousDnt = process.env.DO_NOT_TRACK;
    const previousTelemetry = process.env.CLAUDE_MEM_TELEMETRY;
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(echoedStartBody(String(sent.setup_flow_id))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      delete process.env.DO_NOT_TRACK;
      process.env.CLAUDE_MEM_TELEMETRY = 'on';
      const pairing = await startInstallerOAuthPairing({ setupFlowId: flow });
      expect(sent.setup_flow_id).toBe(flow);
      expect(lastOAuthStartFailure()).toBeNull();
      expect(pairing?.pairingId).toBe(pairingId);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousDnt === undefined) delete process.env.DO_NOT_TRACK; else process.env.DO_NOT_TRACK = previousDnt;
      if (previousTelemetry === undefined) delete process.env.CLAUDE_MEM_TELEMETRY; else process.env.CLAUDE_MEM_TELEMETRY = previousTelemetry;
    }
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

  it('sends install_completed for a person\'s install, and none for an installer run the auto-updater started', () => {
    const runCaptureInstallCompleted = (extraEnv: Record<string, string>): string => {
      mkdirSync(scratchRoot, { recursive: true });
      const dataDir = mkdtempSync(join(scratchRoot, 'claude-mem-installer-completed-'));
      try {
        const script = `
          globalThis.fetch = async () => { console.log('__FETCH_CALLED__'); return new Response('{}', { status: 200 }); };
          const { captureInstallCompleted } = await import('./src/npx-cli/commands/install.ts');
          await captureInstallCompleted({ ide: 'claude-code', is_update: true, outcome: 'ok' });
          console.log('__CAPTURE_DONE__');
        `;
        const env: Record<string, string | undefined> = {
          ...process.env,
          CLAUDE_MEM_DATA_DIR: dataDir,
          // Consent on, and debug mode prints the event instead of sending it (cli-telemetry.ts).
          CLAUDE_MEM_TELEMETRY: '1',
          CLAUDE_MEM_TELEMETRY_DEBUG: '1',
          ...extraEnv,
        };
        delete env.DO_NOT_TRACK;
        const result = Bun.spawnSync([process.execPath, '--eval', script], { cwd: repoRoot, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
        const output = decoder.decode(result.stdout) + decoder.decode(result.stderr);
        expect(result.exitCode, output).toBe(0);
        expect(output).toContain('__CAPTURE_DONE__');
        expect(output).not.toContain('__FETCH_CALLED__');
        return output;
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    };

    expect(runCaptureInstallCompleted({})).toContain('[telemetry] {"event":"install_completed"');
    expect(runCaptureInstallCompleted({ [INSTALL_RUN_BY_AUTO_UPDATE_ENV]: '1' })).not.toContain('"event":"install_completed"');
  });

  it('sends install_failed for a person\'s aborted install, and none for an installer run the auto-updater started', () => {
    const runCaptureInstallFailed = (extraEnv: Record<string, string>): string => {
      mkdirSync(scratchRoot, { recursive: true });
      const dataDir = mkdtempSync(join(scratchRoot, 'claude-mem-installer-failed-'));
      try {
        const script = `
          globalThis.fetch = async () => { console.log('__FETCH_CALLED__'); return new Response('{}', { status: 200 }); };
          const { captureInstallFailed } = await import('./src/npx-cli/commands/install.ts');
          await captureInstallFailed({ error_category: 'marketplace-dir-not-writable', interactive: false });
          console.log('__CAPTURE_DONE__');
        `;
        const env: Record<string, string | undefined> = {
          ...process.env,
          CLAUDE_MEM_DATA_DIR: dataDir,
          // Consent on, and debug mode prints the event instead of sending it (cli-telemetry.ts).
          CLAUDE_MEM_TELEMETRY: '1',
          CLAUDE_MEM_TELEMETRY_DEBUG: '1',
          ...extraEnv,
        };
        delete env.DO_NOT_TRACK;
        const result = Bun.spawnSync([process.execPath, '--eval', script], { cwd: repoRoot, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
        const output = decoder.decode(result.stdout) + decoder.decode(result.stderr);
        expect(result.exitCode, output).toBe(0);
        expect(output).toContain('__CAPTURE_DONE__');
        expect(output).not.toContain('__FETCH_CALLED__');
        return output;
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    };

    expect(runCaptureInstallFailed({})).toContain('[telemetry] {"event":"install_failed"');
    // Any other value is a person's own install, which still reports its failure.
    expect(runCaptureInstallFailed({ [INSTALL_RUN_BY_AUTO_UPDATE_ENV]: '0' })).toContain('[telemetry] {"event":"install_failed"');
    expect(runCaptureInstallFailed({ [INSTALL_RUN_BY_AUTO_UPDATE_ENV]: '1' })).not.toContain('"event":"install_failed"');
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

  it('sends the optional email to the signup endpoint', () => {
    const source = readFileSync(join(repoRoot, 'src/npx-cli/commands/install.ts'), 'utf-8');
    expect(source).toContain("const DEFAULT_SIGNUP_ENDPOINT = 'https://cmem.ai/api/waitlist';");
  });

  it('keeps every privacy statement true now that setup can ask for an email', () => {
    // The opt-in sends an email to cmem.ai, so no copy may still say the CLI
    // contacts cmem.ai only for the sign-in link or never asks for an email.
    const installer = readFileSync(join(repoRoot, 'src/npx-cli/commands/install.ts'), 'utf-8');
    const privacyLine = installer.split('\n').find(line => line.includes('on this machine. cmem.ai'));
    expect(privacyLine).toBeDefined();
    expect(privacyLine).toContain('your email and optional note');
    expect(privacyLine).toContain('numbers-only usage summary');
    const copies = [
      'src/npx-cli/commands/install.ts',
      'docs/public/installation.mdx',
      'docs/public/cmem-pro-headless.mdx',
      'docs/public/cursor/index.mdx',
      'docs/public/hooks-architecture.mdx',
      'src/services/worker/onboarding-explainer.md',
      'plugin/skills/how-it-works/SKILL.md',
    ];
    for (const path of copies) {
      const text = readFileSync(join(repoRoot, path), 'utf-8');
      expect({ path, stale: /contacted? cmem\.ai once|cmem\.ai is contacted once|does \*\*not\*\* ask for an email|no email in the CLI|No email address or identity is accepted/.test(text) })
        .toEqual({ path, stale: false });
    }
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
      memory: {
        memoryKey: 'cm_pro_memory_secret',
        memoryBaseUrl: 'https://cmem.ai/api/inference/v1',
        memoryModel: 'cmem-observer-v2',
      },
      plan: 'pro',
      trialEndsAt: '2026-09-02T12:00:00.000Z',
      team: null,
      teambrainUrl: null,
    });
  });

  it('fills in only the gateway endpoint and model beside a delivered key', () => {
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'user_123',
      setup_token: 'setup_secret',
      hub_url: 'https://sync.cmem.ai',
      memory_key: 'cm_pro_memory_secret',
    })?.memory).toEqual({ memoryKey: 'cm_pro_memory_secret', memoryBaseUrl: CMEM_PRO_BASE_URL, memoryModel: CMEM_PRO_MODEL });
  });

  it('never stands the setup token or the gateway in for observer credentials the server did not send', () => {
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'legacy_user',
      setup_token: 'legacy_one_shot_token',
      hub_url: 'https://legacy-sync.cmem.ai',
    })).toEqual({
      userId: 'legacy_user',
      setupToken: 'legacy_one_shot_token',
      hubUrl: 'https://legacy-sync.cmem.ai',
      memory: null,
      plan: 'trial',
      trialEndsAt: null,
      team: null,
      teambrainUrl: null,
    });
  });

  it('reads a TeamBrain seat holder: sync only, the team and its TeamBrain address', () => {
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'seat_user',
      setup_token: 'seat_setup_token',
      hub_url: 'https://sync.cmem.ai',
      plan: 'teambrain_seat',
      team: { id: 'team_1', name: 'Acme Eng' },
      teambrain_url: 'https://cmem.ai',
    })).toEqual({
      userId: 'seat_user',
      setupToken: 'seat_setup_token',
      hubUrl: 'https://sync.cmem.ai',
      memory: null,
      plan: 'teambrain_seat',
      trialEndsAt: null,
      team: { id: 'team_1', name: 'Acme Eng' },
      teambrainUrl: 'https://cmem.ai',
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
      team: { name: 'no id' },
      teambrain_url: '',
    })).toEqual({
      userId: 'user_123',
      setupToken: 'setup_secret',
      hubUrl: 'https://sync.cmem.ai',
      memory: null,
      plan: 'trial',
      trialEndsAt: null,
      team: null,
      teambrainUrl: null,
    });
  });

  it('writes only the sync connection for a body without observer credentials', () => {
    const settings = buildTrialReadySettings(parseTrialReadyBody({
      status: 'ready',
      user_id: 'seat_user',
      setup_token: 'seat_setup_token',
      hub_url: 'https://sync.cmem.ai',
      plan: 'teambrain_seat',
    })!, 'test-device');
    expect(settings).toEqual({
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'seat_setup_token',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'seat_user',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.cmem.ai',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'test-device',
    });
  });

  it('stages one-shot credentials atomically without choosing a provider', () => {
    const settings = buildTrialReadySettings({
      userId: 'user_123',
      setupToken: 'setup_secret',
      hubUrl: 'https://sync.cmem.ai',
      memory: {
        memoryKey: 'cm_pro_memory_secret',
        memoryBaseUrl: 'https://cmem.ai/api/inference/v1',
        memoryModel: 'cmem-observer',
      },
      plan: 'none',
      trialEndsAt: null,
      team: null,
      teambrainUrl: null,
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
    // Windows has no POSIX permission bits: stat reports 0o666 for a writable file.
    if (process.platform !== 'win32') expect(settingsMode).toBe(0o600);
  });

  it('persists a seat-only ready response as the sync connection alone, leaving the observer as it was', () => {
    const { output, settings } = runCompletedPairingChild({
      status: 'ready',
      user_id: 'seat_user',
      setup_token: 'SEAT_TOKEN_MUST_NOT_LEAK',
      hub_url: 'https://sync.cmem.ai',
      plan: 'teambrain_seat',
      team: { id: 'team_1', name: 'Acme Eng' },
      teambrain_url: 'https://cmem.ai',
    }, {
      CLAUDE_MEM_PROVIDER: 'gemini',
      CLAUDE_MEM_GEMINI_API_KEY: 'personal-gemini-key',
      CLAUDE_MEM_OPENROUTER_BASE_URL: '',
      CLAUDE_MEM_PRO_MEMORY_KEY: '',
    });

    expect(output).toContain('__PAIRING_RESULT__={"plan":"teambrain_seat","ready":true}');
    expect(output).not.toContain('SEAT_TOKEN_MUST_NOT_LEAK');
    expect(settings).toEqual({
      CLAUDE_MEM_PROVIDER: 'gemini',
      CLAUDE_MEM_GEMINI_API_KEY: 'personal-gemini-key',
      CLAUDE_MEM_OPENROUTER_BASE_URL: '',
      CLAUDE_MEM_PRO_MEMORY_KEY: '',
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'SEAT_TOKEN_MUST_NOT_LEAK',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'seat_user',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.cmem.ai',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: expect.any(String),
    });
  });

  it.each(['teambrain_seat', 'cloud_sync'])('keeps the provider for a %s account, promoting no staged gateway key', (plan) => {
    const script = `
      const { writeFileSync, readFileSync } = await import('fs');
      const { USER_SETTINGS_PATH } = await import('./src/shared/paths.ts');
      const before = JSON.stringify({
        CLAUDE_MEM_PROVIDER: 'gemini',
        CLAUDE_MEM_GEMINI_API_KEY: 'personal-gemini-key',
        CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_staged_by_an_old_pairing',
        CLAUDE_MEM_PRO_MEMORY_BASE_URL: 'https://cmem.ai/api/inference/v1',
        CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'seat_setup_token',
        CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'seat_user',
        CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.cmem.ai',
      }, null, 2);
      writeFileSync(USER_SETTINGS_PATH, before);
      const { parseTrialReadyBody, promptProvider } = await import('./src/npx-cli/commands/install.ts');
      const delivered = parseTrialReadyBody({
        status: 'ready', user_id: 'seat_user', setup_token: 'seat_setup_token',
        hub_url: 'https://sync.cmem.ai', plan: '${plan}',
      });
      const pairing = {
        pairingId: 'p', secret: 's', userCode: 'ABCD-2345', pollIntervalMs: 1,
        authorizationUrl: 'https://cmem.ai/login', checkoutUrl: 'https://cmem.ai/api/pro/trial/claim?pairing=p&trial=7',
        delivered,
      };
      const provider = await promptProvider({ provider: 'cmem', providerSource: 'flag' }, pairing, 'test-version');
      console.log('__PROVIDER__=' + provider);
      console.log('__UNCHANGED__=' + String(readFileSync(USER_SETTINGS_PATH, 'utf-8') === before));
    `;
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-installer-seat-'));
    try {
      const result = Bun.spawnSync([process.execPath, '--eval', script], {
        cwd: repoRoot,
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_MEM_TELEMETRY: '0' },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = decoder.decode(result.stdout) + decoder.decode(result.stderr);
      expect(result.exitCode, output).toBe(0);
      expect(output).toContain('__PROVIDER__=gemini');
      expect(output).toContain('__UNCHANGED__=true');
      if (plan === 'cloud_sync') {
        expect(output).toContain('Cloud Sync is connected');
        expect(output).toContain('https://cmem.ai/hosted-tokens');
        expect(output).not.toContain('TeamBrain seat');
        expect(output).not.toContain('https://cmem.ai/pro');
      } else {
        expect(output).toContain('TeamBrain seat');
      }
      expect(output).not.toContain('CMEM Pro configured');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
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


describe('browser checkout memory activation', () => {
  it('activates delivered memory credentials and keeps sync-only accounts on their existing provider', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-browser-activation-'));
    try {
      const script = `
        const { activateBrowserEnrollment } = await import('./src/npx-cli/commands/install.ts');
        const memory = { memoryKey: 'test-memory-key', memoryBaseUrl: 'https://cmem.ai/api/observer/v1', memoryModel: 'cmem-test' };
        const first = activateBrowserEnrollment({ memory });
        const second = activateBrowserEnrollment({ memory: null });
        console.log(JSON.stringify({ first, second }));
      `;
      const result = Bun.spawnSync([process.execPath, '--eval', script], { cwd: repoRoot, env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_MEM_TELEMETRY: '0' }, stdout: 'pipe', stderr: 'pipe' });
      expect(result.exitCode, decoder.decode(result.stderr)).toBe(0);
      expect(JSON.parse(decoder.decode(result.stdout).trim())).toEqual({ first: 'openrouter', second: null });
      const settings = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'));
      expect(settings.CLAUDE_MEM_PROVIDER).toBe('openrouter');
      expect(settings.CLAUDE_MEM_OPENROUTER_API_KEY).toBe('test-memory-key');
      expect(settings.CLAUDE_MEM_OPENROUTER_MODEL).toBe('cmem-test');
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
});
