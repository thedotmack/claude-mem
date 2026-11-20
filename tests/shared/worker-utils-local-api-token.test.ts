// Local API token mode (#5141), client side: which requests carry the token, and where it comes from.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { LOCAL_API_TOKEN_HEADER } from '../../src/shared/local-api-token.js';
import { clearPortCache, withWorkerAuth, workerAuthHeaders, workerHttpRequest } from '../../src/shared/worker-utils.js';

const TOKEN = 'client-owner-test-secret';
const SETTINGS_ENV = ['CLAUDE_MEM_DATA_DIR', 'CLAUDE_MEM_WORKER_URL', 'CLAUDE_MEM_WORKER_HOST', 'CLAUDE_MEM_WORKER_PORT', 'CLAUDE_MEM_LOCAL_API_TOKEN'] as const;

let dataDir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(SETTINGS_ENV.map((key) => [key, process.env[key]]));
  for (const key of SETTINGS_ENV) delete process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), 'cm-owner-client-'));
  process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  clearPortCache();
});

afterEach(() => {
  for (const key of SETTINGS_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearPortCache();
  rmSync(dataDir, { recursive: true, force: true });
});

function writeSettings(settings: Record<string, string>): void {
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings));
  clearPortCache();
}

describe('workerAuthHeaders', () => {
  it('adds nothing when settings.json has no token', () => {
    writeSettings({ CLAUDE_MEM_WORKER_HOST: '127.0.0.1' });
    expect(workerAuthHeaders()).toEqual({});
  });

  it('adds the token header for the local worker', () => {
    writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: `  ${TOKEN} ` });
    expect(workerAuthHeaders()).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
  });

  it('adds the token for a worker URL that names this machine\'s own worker address', () => {
    writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN, CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: '41999', CLAUDE_MEM_WORKER_URL: 'http://127.0.0.1:41999' });
    expect(workerAuthHeaders()).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
  });

  // An SSH forward to another machine's worker looks like loopback; the docs promise it never gets the token.
  it('never sends the token to an explicit worker URL on another address, loopback included', () => {
    writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN, CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: '41999', CLAUDE_MEM_WORKER_URL: 'http://127.0.0.1:9' });
    expect(workerAuthHeaders()).toEqual({});
  });

  it('sends what settings.json says, whatever the environment says', () => {
    writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN });
    process.env.CLAUDE_MEM_LOCAL_API_TOKEN = 'from-the-environment';
    clearPortCache();
    expect(workerAuthHeaders()).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
    process.env.CLAUDE_MEM_LOCAL_API_TOKEN = '';
    clearPortCache();
    expect(workerAuthHeaders()).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
    writeSettings({});
    process.env.CLAUDE_MEM_LOCAL_API_TOKEN = 'from-the-environment';
    clearPortCache();
    expect(workerAuthHeaders()).toEqual({});
  });

  it('never sends the token to a remote worker', () => {
    writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN, CLAUDE_MEM_WORKER_URL: 'https://worker.example.com' });
    expect(workerAuthHeaders()).toEqual({});
  });
});

describe('withWorkerAuth', () => {
  it('returns the very same init when there is no token', () => {
    writeSettings({});
    const init = { method: 'POST' };
    expect(withWorkerAuth(init)).toBe(init);
  });

  it('adds the header and keeps everything the caller set', () => {
    writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN });
    const init = withWorkerAuth({ method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    const headers = new Headers(init.headers);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get(LOCAL_API_TOKEN_HEADER)).toBe(TOKEN);
  });

  it('lets a header the caller already set win', () => {
    writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN });
    const headers = new Headers(withWorkerAuth({ headers: { [LOCAL_API_TOKEN_HEADER]: 'explicit' } }).headers);
    expect(headers.get(LOCAL_API_TOKEN_HEADER)).toBe('explicit');
  });
});

describe('workerHttpRequest', () => {
  it('sends the token on a real request, beside the caller headers', async () => {
    const seen: Headers[] = [];
    const worker = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) { seen.push(req.headers); return Response.json({ ok: true }); } });
    try {
      writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN, CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(worker.port) });
      const response = await workerHttpRequest('/api/anything', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0].get(LOCAL_API_TOKEN_HEADER)).toBe(TOKEN);
      expect(seen[0].get('content-type')).toBe('application/json');
    } finally {
      worker.stop(true);
    }
  });

  it('sends no token header when settings.json has none', async () => {
    const seen: Headers[] = [];
    const worker = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) { seen.push(req.headers); return Response.json({ ok: true }); } });
    try {
      writeSettings({ CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(worker.port) });
      await workerHttpRequest('/api/anything');
      expect(seen).toHaveLength(1);
      expect(seen[0].has(LOCAL_API_TOKEN_HEADER)).toBe(false);
    } finally {
      worker.stop(true);
    }
  });
});

// USER_SETTINGS_PATH is fixed when paths.ts loads, so the servers' reader is checked in a child
// process that starts with CLAUDE_MEM_DATA_DIR already set.
describe('readLocalApiToken (what the worker and the MCP server read)', () => {
  const hookSettings = pathToFileURL(join(import.meta.dir, '../../src/shared/hook-settings.ts')).href;

  function readInChild(env: Record<string, string>): string {
    const child = Bun.spawnSync(
      [process.execPath, '-e', `import { readLocalApiToken } from '${hookSettings}'; process.stdout.write(JSON.stringify(readLocalApiToken()));`],
      { env: { ...(process.env as Record<string, string>), CLAUDE_MEM_DATA_DIR: dataDir, ...env }, stderr: 'pipe' },
    );
    expect(child.exitCode).toBe(0);
    return JSON.parse(child.stdout.toString());
  }

  it('reads the token from settings.json, trimmed', () => {
    writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: `  ${TOKEN}\n` });
    expect(readInChild({})).toBe(TOKEN);
  });

  it('ignores the environment: it cannot switch the mode on', () => {
    writeSettings({});
    expect(readInChild({ CLAUDE_MEM_LOCAL_API_TOKEN: 'from-the-environment' })).toBe('');
  });

  it('ignores the environment: it cannot switch the mode off or change the token', () => {
    writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN });
    expect(readInChild({ CLAUDE_MEM_LOCAL_API_TOKEN: '' })).toBe(TOKEN);
    expect(readInChild({ CLAUDE_MEM_LOCAL_API_TOKEN: 'from-the-environment' })).toBe(TOKEN);
  });

  it('reads whitespace-only as off, and does not create a missing settings file', () => {
    writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: '   ' });
    expect(readInChild({})).toBe('');
    rmSync(join(dataDir, 'settings.json'));
    expect(readInChild({})).toBe('');
    expect(existsSync(join(dataDir, 'settings.json'))).toBe(false);
  });
});
