// Local API token mode (#5141) in the Pi and DSH harness client: the token comes from
// settings.json alone, as the worker reads it, and goes only to a loopback worker.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveHarnessAuthHeaders } from '../../src/integrations/harness-worker.js';
import { LOCAL_API_TOKEN_HEADER } from '../../src/shared/local-api-token.js';

const TOKEN = 'harness-owner-test-secret';
const ENV_KEYS = ['CLAUDE_MEM_DATA_DIR', 'CLAUDE_MEM_LOCAL_API_TOKEN', 'CLAUDE_MEM_WORKER_PORT', 'CLAUDE_MEM_WORKER_HOST'] as const;

let dataDir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  delete process.env.CLAUDE_MEM_LOCAL_API_TOKEN;
  delete process.env.CLAUDE_MEM_WORKER_PORT;
  delete process.env.CLAUDE_MEM_WORKER_HOST;
  dataDir = mkdtempSync(join(tmpdir(), 'cm-harness-owner-'));
  process.env.CLAUDE_MEM_DATA_DIR = dataDir;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const writeSettings = (settings: Record<string, string>) => writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings));

describe('resolveHarnessAuthHeaders', () => {
  it('sends the settings.json token to a loopback worker', () => {
    writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN, CLAUDE_MEM_WORKER_PORT: '37777' });
    expect(resolveHarnessAuthHeaders('http://127.0.0.1:37777')).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
  });

  it('never sends it to a worker on another host', () => {
    writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN, CLAUDE_MEM_WORKER_PORT: '37777' });
    expect(resolveHarnessAuthHeaders('http://worker.example.com:37777')).toEqual({});
  });

  // DSH's baseUrl is configurable; another loopback port may be an SSH forward to another machine.
  it('never sends it to a loopback address other than the configured worker', () => {
    writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN, CLAUDE_MEM_WORKER_PORT: '37777' });
    expect(resolveHarnessAuthHeaders('http://127.0.0.1:9')).toEqual({});
    expect(resolveHarnessAuthHeaders('http://127.0.0.1:37777')).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
  });

  it('ignores the environment: it can neither supply nor replace the token', () => {
    writeSettings({});
    process.env.CLAUDE_MEM_LOCAL_API_TOKEN = 'from-the-environment';
    expect(resolveHarnessAuthHeaders('http://127.0.0.1:37777')).toEqual({});
    writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN, CLAUDE_MEM_WORKER_PORT: '37777' });
    expect(resolveHarnessAuthHeaders('http://127.0.0.1:37777')).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
  });
});
