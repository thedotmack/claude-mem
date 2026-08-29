// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CMEM_PRO_TRIAL_LENGTHS,
  CMEM_PRO_TRIAL_START_URL,
  cmemProSignupUrl,
  cmemProTrialPitch,
  cmemProTrialVariant,
  parseCmemProTrialDays,
  pickCmemProTrialDays,
} from '../../src/npx-cli/cmem-pro-costs.js';
import {
  captureInstallerProOfferViewed,
  parseStoredTrialState,
  resolveInstallerTrialDays,
  startTrialPairing,
} from '../../src/npx-cli/commands/install.js';

const originalFetch = globalThis.fetch;
const originalTelemetryEnv = {
  CLAUDE_MEM_TELEMETRY: process.env.CLAUDE_MEM_TELEMETRY,
  CLAUDE_MEM_TELEMETRY_DEBUG: process.env.CLAUDE_MEM_TELEMETRY_DEBUG,
  CLAUDE_MEM_TELEMETRY_HOST: process.env.CLAUDE_MEM_TELEMETRY_HOST,
  CLAUDE_MEM_TELEMETRY_KEY: process.env.CLAUDE_MEM_TELEMETRY_KEY,
  CLAUDE_MEM_DATA_DIR: process.env.CLAUDE_MEM_DATA_DIR,
  DO_NOT_TRACK: process.env.DO_NOT_TRACK,
};
let telemetryDataDir: string | null = null;
const installSource = readFileSync(
  join(__dirname, '..', '..', 'src', 'npx-cli', 'commands', 'install.ts'),
  'utf-8',
);

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (telemetryDataDir) {
    rmSync(telemetryDataDir, { recursive: true, force: true });
    telemetryDataDir = null;
  }
  for (const [key, value] of Object.entries(originalTelemetryEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('installer trial length', () => {
  it('offers 30 days on every run while 7 and 14 stay accepted values', () => {
    expect(CMEM_PRO_TRIAL_LENGTHS).toEqual([7, 14, 30]);
    expect(pickCmemProTrialDays()).toBe(30);
  });

  it('accepts only exact persisted 7/14/30 values', () => {
    for (const days of CMEM_PRO_TRIAL_LENGTHS) {
      expect(parseCmemProTrialDays(days)).toBe(days);
      expect(parseCmemProTrialDays(String(days))).toBe(days);
    }
    for (const invalid of [undefined, null, 0, 21, '07', '14 ', '30 days', {}, []]) {
      expect(parseCmemProTrialDays(invalid)).toBeNull();
    }
  });

  it.each(CMEM_PRO_TRIAL_LENGTHS)('uses %d days in installer offer copy and the /pro URL', (trialDays) => {
    expect(cmemProTrialPitch(trialDays)).toContain(`${trialDays}-day trial`);
    expect(cmemProSignupUrl(trialDays)).toBe(
      `https://cmem.ai/pro?from=installer&trial=${trialDays}`,
    );
  });

  it('maps every trial length to the canonical cmem.ai experiment arm', () => {
    expect(CMEM_PRO_TRIAL_LENGTHS.map(cmemProTrialVariant)).toEqual([
      'control_7',
      'test_14',
      'test_30',
    ]);
  });

  it('captures one installer offer exposure per call for all arms on the stable install id', async () => {
    telemetryDataDir = mkdtempSync(join(tmpdir(), 'claude-mem-offer-telemetry-'));
    process.env.CLAUDE_MEM_DATA_DIR = telemetryDataDir;
    process.env.CLAUDE_MEM_TELEMETRY = '1';
    process.env.DO_NOT_TRACK = '0';
    delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
    process.env.CLAUDE_MEM_TELEMETRY_HOST = 'https://telemetry.example';
    process.env.CLAUDE_MEM_TELEMETRY_KEY = 'test-key';

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    for (const trialDays of CMEM_PRO_TRIAL_LENGTHS) {
      await captureInstallerProOfferViewed(trialDays);
    }

    expect(requests).toHaveLength(3);
    expect(requests.every(({ url }) => url === 'https://telemetry.example/capture/')).toBe(true);
    expect(new Set(requests.map(({ body }) => body.distinct_id)).size).toBe(1);
    for (const [index, trialDays] of CMEM_PRO_TRIAL_LENGTHS.entries()) {
      expect(requests[index]?.body).toMatchObject({
        api_key: 'test-key',
        event: 'pro_offer_viewed',
        distinct_id: expect.any(String),
        properties: {
          trial_days: trialDays,
          trial_variant: cmemProTrialVariant(trialDays),
          offer_surface: 'installer',
          funnel_source: 'installer',
          $process_person_profile: false,
        },
      });
    }
  });

  it.each(CMEM_PRO_TRIAL_LENGTHS)('sends %d days to trial start and retains it for later copy', async (trialDays) => {
    let requestUrl: string | URL | Request | undefined;
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = url;
      requestInit = init;
      return new Response(JSON.stringify({
        pairing_id: 'pairing-123',
        secret: 'secret-456',
        poll_interval: 3,
        user_code: 'ABCD-1234',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const pairing = await startTrialPairing('person@example.com', trialDays);

    expect(requestUrl).toBe(CMEM_PRO_TRIAL_START_URL);
    expect(requestInit?.method).toBe('POST');
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      email: 'person@example.com',
      source: 'npx-installer',
      device_name: expect.any(String),
      trial: trialDays,
    });
    expect(pairing).toMatchObject({
      pairingId: 'pairing-123',
      secret: 'secret-456',
      trialDays,
      userCode: 'ABCD-1234',
    });
  });

  it('reuses the persisted arm on a later run/resend without randomizing again', () => {
    const prior = parseStoredTrialState({
      CLAUDE_MEM_PRO_TRIAL_EMAIL: 'person@example.com',
      CLAUDE_MEM_PRO_TRIAL_STATE: 'link_sent',
      CLAUDE_MEM_PRO_TRIAL_DAYS: '14',
    });
    expect(prior?.trialDays).toBe(14);
    expect(resolveInstallerTrialDays(prior)).toBe(14);
  });

  it('falls back to the default arm for a fresh or invalid legacy state', () => {
    const invalidPrior = parseStoredTrialState({
      CLAUDE_MEM_PRO_TRIAL_EMAIL: 'person@example.com',
      CLAUDE_MEM_PRO_TRIAL_STATE: 'link_sent',
      CLAUDE_MEM_PRO_TRIAL_DAYS: 'forever',
    });

    expect(invalidPrior?.trialDays).toBeNull();
    expect(resolveInstallerTrialDays(invalidPrior)).toBe(30);
  });

  it('chooses once at funnel entry and carries that value through every installer path', () => {
    expect(installSource.match(/resolveInstallerTrialDays\(storedTrialState\)/g)).toHaveLength(1);
    expect(installSource.match(/pickCmemProTrialDays\(\)/g)).toHaveLength(1);
    expect(installSource).toContain('promptProTrialOptIn(version, trialDays, storedTrialState)');
    expect(installSource).toContain('promptProvider(options, trialDays)');
    expect(installSource).toContain('cmemProSignupUrl(trialDays)');
    expect(installSource).toContain('cmemProTrialPitch(trialDays)');
    expect(installSource.match(/CLAUDE_MEM_PRO_TRIAL_DAYS: String\(trialDays\)/g)).toHaveLength(2);
    expect(installSource).not.toMatch(/free week|7 days free|7-day trial/i);
  });

  it('records all four real offer surfaces once without counting resend/activation copy', () => {
    const resendFlow = installSource.slice(
      installSource.indexOf('if (prior) {'),
      installSource.indexOf('// The alt-path figure is live-fetched'),
    );
    expect(resendFlow).not.toContain('captureInstallerProOfferViewed');

    const optInOffer = installSource.slice(
      installSource.indexOf('// The alt-path figure is live-fetched'),
      installSource.indexOf("const emailResult = await p.text({"),
    );
    expect(optInOffer).toContain("p.note(");
    expect(optInOffer.match(/void captureInstallerProOfferViewed\(trialDays\);/g)).toHaveLength(1);

    const providerChoiceOffer = installSource.slice(
      installSource.indexOf('const labels = await buildProviderLabels(trialDays);'),
      installSource.indexOf('if (p.isCancel(providerResult))'),
    );
    expect(providerChoiceOffer).toContain('const providerResultPromise = p.select<ProviderChoice>({');
    expect(providerChoiceOffer).toContain('const providerResult = await providerResultPromise;');
    expect(providerChoiceOffer.match(/void captureInstallerProOfferViewed\(trialDays\);/g)).toHaveLength(1);

    const selectedCmemOffer = installSource.slice(
      installSource.indexOf("if (selectedProvider === 'cmem') {"),
      installSource.indexOf("const keyResult = await p.text({"),
    );
    expect(selectedCmemOffer).toContain('Opening ${signupUrl}');
    expect(selectedCmemOffer.match(/void captureInstallerProOfferViewed\(trialDays\);/g)).toHaveLength(1);

    const finalOffer = installSource.slice(
      installSource.indexOf('const proOfferDisplayed = !trialActivated;'),
      installSource.indexOf('// After promptTelemetryOptIn so a just-made consent choice is honored.'),
    );
    expect(finalOffer).toContain('cmemProTrialPitch(trialDays)');
    expect(finalOffer.match(/await captureInstallerProOfferViewed\(trialDays\);/g)).toHaveLength(1);
  });
});
