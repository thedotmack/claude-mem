import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawn, spawnSync } from 'child_process';
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

  it('reuses credentials across process restarts without a network request', async () => {
    await getOrCreateIntentCredentials({ origin, configPath, fetch: mock(async () => Response.json(credentials)) as typeof fetch });
    const modulePath = resolve(import.meta.dir, '../../src/shared/intent-credentials.ts');
    const child = spawnSync(process.execPath, ['-e', `
      import { getOrCreateIntentCredentials } from ${JSON.stringify(modulePath)};
      const saved = await getOrCreateIntentCredentials({
        origin: ${JSON.stringify(origin)}, configPath: ${JSON.stringify(configPath)},
        fetch: async () => { throw new Error('unexpected network request after restart'); },
      });
      process.stdout.write(JSON.stringify(saved));
    `], { encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(credentials);
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

  it('shows and retains the server error message without reissuing on retry', async () => {
    const message = 'Hosted setup is temporarily unavailable. Please try again later.';
    const fetcher = mock(async () => Response.json({ message, internal: 'not persisted' }, { status: 503 }));
    await expect(getOrCreateIntentCredentials({ origin, configPath, fetch: fetcher as typeof fetch })).rejects.toThrow(message);
    await expect(getOrCreateIntentCredentials({ origin, configPath, fetch: fetcher as typeof fetch })).rejects.toThrow(message);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ state: 'pending', message });
    if (process.platform !== 'win32') expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

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

  it('retains the reservation when the issuing process crashes after starting its request', async () => {
    const modulePath = resolve(import.meta.dir, '../../src/shared/intent-credentials.ts');
    const child = spawnSync(process.execPath, ['-e', `
      import { getOrCreateIntentCredentials } from ${JSON.stringify(modulePath)};
      await getOrCreateIntentCredentials({
        origin: ${JSON.stringify(origin)}, configPath: ${JSON.stringify(configPath)},
        fetch: async () => process.exit(0),
      });
    `], { encoding: 'utf8' });
    expect(child.status).toBe(0);
    const fetcher = mock(async () => Response.json(credentials));
    await expect(getOrCreateIntentCredentials({ origin, configPath, fetch: fetcher as typeof fetch }))
      .rejects.toThrow('refusing to create another installation identity');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('prevents another process from issuing while the first owns the reservation', async () => {
    const modulePath = resolve(import.meta.dir, '../../src/shared/intent-credentials.ts');
    const child = spawn(process.execPath, ['-e', `
      import { getOrCreateIntentCredentials } from ${JSON.stringify(modulePath)};
      await getOrCreateIntentCredentials({
        origin: ${JSON.stringify(origin)}, configPath: ${JSON.stringify(configPath)},
        fetch: async () => {
          process.stdout.write('reserved');
          await new Promise(resolve => process.stdin.once('data', resolve));
          return Response.json(${JSON.stringify(credentials)});
        },
      });
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolveReady, reject) => {
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`Credential issuer exited early: ${code}`)));
        child.stdout.once('data', () => resolveReady());
      });
      const fetcher = mock(async () => Response.json(credentials));
      await expect(getOrCreateIntentCredentials({ origin, configPath, fetch: fetcher as typeof fetch }))
        .rejects.toThrow('refusing to create another installation identity');
      expect(fetcher).not.toHaveBeenCalled();
      const finished = new Promise<number | null>(resolveExit => child.once('exit', resolveExit));
      child.stdin.end('finish');
      expect(await finished).toBe(0);
      expect(readIntentCredentials(configPath)).toEqual(credentials);
    } finally {
      child.kill();
    }
  });

  it('uses the same exact install headers for anonymous and account requests', () => {
    expect(intentCredentialHeaders(credentials)).toEqual({
      'X-Intent-Install-Id': credentials.install_id,
      'X-Intent-Token': credentials.intent_token,
    });
    expect(intentCredentialHeaders(null)).toEqual({});
  });
});
