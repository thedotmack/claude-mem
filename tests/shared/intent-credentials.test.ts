import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getOrCreateIntentCredentials,
  intentCredentialHeaders,
  readIntentCredentials,
} from '../../src/shared/intent-credentials.js';

const credentials = { install_id: 'a'.repeat(32), intent_token: 'b'.repeat(64) };
const origin = 'https://hosted-intent.invalid';

describe('persistent hosted intent installation credentials', () => {
  let directory: string;
  let configPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'intent-credentials-'));
    configPath = join(directory, 'intent-install.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('issues without authentication/body, privately persists, and reuses a later invocation', async () => {
    const fetcher = mock(async () => Response.json(credentials));
    expect(await getOrCreateIntentCredentials({ origin: `${origin}/`, configPath, fetch: fetcher as typeof fetch }))
      .toEqual(credentials);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([`${origin}/api/installer/intent`, { method: 'POST' }]);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(credentials);
    if (process.platform !== 'win32') expect(statSync(configPath).mode & 0o777).toBe(0o600);

    const laterFetcher = mock(async () => { throw new Error('must reuse the saved identity'); });
    expect(readIntentCredentials(configPath)).toEqual(credentials);
    expect(await getOrCreateIntentCredentials({ origin, configPath, fetch: laterFetcher as typeof fetch })).toEqual(credentials);
    expect(laterFetcher).not.toHaveBeenCalled();
  });

  it('resolves its default path from the installation data directory at call time', async () => {
    const previous = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = directory;
    try {
      expect(readIntentCredentials()).toBeNull();
      expect(await getOrCreateIntentCredentials({ origin, fetch: mock(async () => Response.json(credentials)) as typeof fetch }))
        .toEqual(credentials);
      expect(readIntentCredentials()).toEqual(credentials);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
      else process.env.CLAUDE_MEM_DATA_DIR = previous;
    }
  });

  it('makes an existing credential file private before reusing it', () => {
    writeFileSync(configPath, JSON.stringify(credentials));
    chmodSync(configPath, 0o644);
    expect(readIntentCredentials(configPath)).toEqual(credentials);
    if (process.platform !== 'win32') expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  for (const [name, value] of [
    ['malformed JSON', '{'],
    ['a partial credential', JSON.stringify({ install_id: credentials.install_id })],
    ['uppercase identifiers', JSON.stringify({ ...credentials, install_id: 'A'.repeat(32) })],
    ['an invalid token length', JSON.stringify({ ...credentials, intent_token: 'b'.repeat(63) })],
  ]) {
    it(`does not replace ${name} with another identity`, async () => {
      writeFileSync(configPath, value);
      const fetcher = mock(async () => Response.json(credentials));
      expect(() => readIntentCredentials(configPath)).toThrow('refusing to create another installation identity');
      await expect(getOrCreateIntentCredentials({ origin, configPath, fetch: fetcher as typeof fetch }))
        .rejects.toThrow('refusing to create another installation identity');
      expect(fetcher).not.toHaveBeenCalled();
      expect(readFileSync(configPath, 'utf8')).toBe(value);
    });
  }

  for (const [error, status] of [['rate_limited', 429], ['anonymous_daily_budget_reached', 503], ['intent_install_limit', 429]] as const) {
    it(`clears the reservation after the service refuses with ${error}, so the next run asks again`, async () => {
      const message = 'Hosted setup is temporarily unavailable. Please try again later.';
      const refusal = mock(async () => Response.json({ error, message, internal: 'not persisted' }, { status }));
      await expect(getOrCreateIntentCredentials({ origin, configPath, fetch: refusal as typeof fetch })).rejects.toThrow(message);
      expect(refusal).toHaveBeenCalledTimes(1);
      expect(existsSync(configPath)).toBe(false);
      expect(readIntentCredentials(configPath)).toBeNull();

      const later = mock(async () => Response.json(credentials));
      expect(await getOrCreateIntentCredentials({ origin, configPath, fetch: later as typeof fetch })).toEqual(credentials);
      expect(later).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(credentials);
    });
  }

  it('uses a generic message for a refusal without one and still clears the reservation', async () => {
    const refusal = mock(async () => Response.json({ error: 'rate_limited' }, { status: 429 }));
    await expect(getOrCreateIntentCredentials({ origin, configPath, fetch: refusal as typeof fetch }))
      .rejects.toThrow('Hosted intent credential request failed (HTTP 429).');
    expect(existsSync(configPath)).toBe(false);
  });

  for (const [name, response] of [
    ['a gateway timeout page', () => new Response('An error occurred with your deployment', { status: 504 })],
    ['a JSON reply without the service error code', () => Response.json({ message: 'Upstream unavailable.' }, { status: 502 })],
    // The handler's catch-all can follow a committed issuance.
    ['the service catch-all intent_install_unavailable', () => Response.json({ error: 'intent_install_unavailable', message: 'Could not create an install credential. Try again later.' }, { status: 503 })],
    ['an error code not known to mean nothing was issued', () => Response.json({ error: 'internal_error' }, { status: 500 })],
  ] as const) {
    it(`keeps the reservation after ${name}, because the service may have issued`, async () => {
      const fetcher = mock(async () => response());
      await expect(getOrCreateIntentCredentials({ origin, configPath, fetch: fetcher as typeof fetch })).rejects.toThrow();
      const saved = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(saved.state).toBe('pending');
      expect(JSON.stringify(saved)).not.toContain('deployment');
      if (process.platform !== 'win32') expect(statSync(configPath).mode & 0o777).toBe(0o600);
      await expect(getOrCreateIntentCredentials({ origin, configPath, fetch: fetcher as typeof fetch })).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  }

  it('retains a durable reservation after uncertain transport failure', async () => {
    const fetcher = mock(async () => { throw new Error('connection lost after request'); });
    await expect(getOrCreateIntentCredentials({ origin, configPath, fetch: fetcher as typeof fetch }))
      .rejects.toThrow('connection lost after request');
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ state: 'pending' });
    await expect(getOrCreateIntentCredentials({ origin, configPath, fetch: fetcher as typeof fetch }))
      .rejects.toThrow('refusing to create another installation identity');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a reservation after a malformed success without exposing returned secrets', async () => {
    const fetcher = mock(async () => Response.json({ ...credentials, intent_token: 'SECRET-invalid' }));
    await expect(getOrCreateIntentCredentials({ origin, configPath, fetch: fetcher as typeof fetch }))
      .rejects.toThrow('invalid installation credentials');
    expect(readFileSync(configPath, 'utf8')).not.toContain('SECRET-invalid');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('coalesces simultaneous callers into a single issuance', async () => {
    let complete!: (response: Response) => void;
    const fetcher = mock(() => new Promise<Response>(resolveResponse => { complete = resolveResponse; }));
    const first = getOrCreateIntentCredentials({ origin, configPath, fetch: fetcher as typeof fetch });
    const second = getOrCreateIntentCredentials({ origin, configPath, fetch: fetcher as typeof fetch });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ state: 'pending' });
    complete(Response.json(credentials));
    expect(await Promise.all([first, second])).toEqual([credentials, credentials]);
  });



  it('uses the same exact install headers for anonymous and account requests', () => {
    expect(intentCredentialHeaders(credentials)).toEqual({
      'X-Intent-Install-Id': credentials.install_id,
      'X-Intent-Token': credentials.intent_token,
    });
    expect(intentCredentialHeaders(null)).toEqual({});
  });
});
