// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CMEM_PRO_TRIAL_LENGTHS,
  CMEM_PRO_TRIAL_START_URL,
  cmemProSignupUrl,
  cmemProTrialPitch,
  parseCmemProTrialDays,
  pickCmemProTrialDays,
} from '../../src/npx-cli/cmem-pro-costs.js';
import {
  parseStoredTrialState,
  resolveInstallerTrialDays,
  startTrialPairing,
} from '../../src/npx-cli/commands/install.js';

const originalFetch = globalThis.fetch;
const installSource = readFileSync(
  join(__dirname, '..', '..', 'src', 'npx-cli', 'commands', 'install.ts'),
  'utf-8',
);

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('installer trial length', () => {
  it('selects each of the three accepted trial arms', () => {
    expect(CMEM_PRO_TRIAL_LENGTHS).toEqual([7, 14, 30]);
    expect(pickCmemProTrialDays(() => 0)).toBe(7);
    expect(pickCmemProTrialDays(() => 0.34)).toBe(14);
    expect(pickCmemProTrialDays(() => 0.99)).toBe(30);
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
    let randomCalls = 0;

    expect(prior?.trialDays).toBe(14);
    expect(resolveInstallerTrialDays(prior, () => {
      randomCalls += 1;
      return 0.99;
    })).toBe(14);
    expect(randomCalls).toBe(0);
  });

  it('picks exactly once for a fresh or invalid legacy state', () => {
    const invalidPrior = parseStoredTrialState({
      CLAUDE_MEM_PRO_TRIAL_EMAIL: 'person@example.com',
      CLAUDE_MEM_PRO_TRIAL_STATE: 'link_sent',
      CLAUDE_MEM_PRO_TRIAL_DAYS: 'forever',
    });
    let randomCalls = 0;

    expect(invalidPrior?.trialDays).toBeNull();
    expect(resolveInstallerTrialDays(invalidPrior, () => {
      randomCalls += 1;
      return 0.99;
    })).toBe(30);
    expect(randomCalls).toBe(1);
  });

  it('chooses once at funnel entry and carries that value through every installer path', () => {
    expect(installSource.match(/resolveInstallerTrialDays\(storedTrialState\)/g)).toHaveLength(1);
    expect(installSource.match(/pickCmemProTrialDays\(random\)/g)).toHaveLength(1);
    expect(installSource).toContain('promptProTrialOptIn(version, trialDays, storedTrialState)');
    expect(installSource).toContain('promptProvider(options, trialDays)');
    expect(installSource).toContain('cmemProSignupUrl(trialDays)');
    expect(installSource).toContain('cmemProTrialPitch(trialDays)');
    expect(installSource.match(/CLAUDE_MEM_PRO_TRIAL_DAYS: String\(trialDays\)/g)).toHaveLength(2);
    expect(installSource).not.toMatch(/free week|7 days free|7-day trial/i);
  });
});
