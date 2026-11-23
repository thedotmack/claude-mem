// Local API token mode (#5141) in the Pi and DSH harness client: the token comes from
// settings.json alone, as the worker reads it, and goes only to a loopback worker.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveHarnessAuthHeaders, resolveHarnessWorkerUrl } from '../../src/integrations/harness-worker.js';
import { LOCAL_API_TOKEN_HEADER } from '../../src/shared/local-api-token.js';

const TOKEN = 'harness-owner-test-secret';
const ENV_KEYS = [
  'CLAUDE_MEM_DATA_DIR', 'CLAUDE_MEM_LOCAL_API_TOKEN', 'CLAUDE_MEM_WORKER_PORT', 'CLAUDE_MEM_WORKER_HOST',
  'CLAUDE_MEM_WORKER_URL', 'CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST',
] as const;

let dataDir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
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

  // #6390: the opt-in names the one remote worker that may receive the token.
  it('sends it to the remote worker the user names in CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST', () => {
    writeSettings({
      CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN,
      CLAUDE_MEM_WORKER_HOST: 'worker.example.com',
      CLAUDE_MEM_WORKER_PORT: '37777',
      CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST: 'worker.example.com',
    });
    expect(resolveHarnessAuthHeaders('https://worker.example.com')).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
  });

  it('sends nothing to that worker without the opt-in, or when it names another host', () => {
    writeSettings({ CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN, CLAUDE_MEM_WORKER_HOST: 'worker.example.com', CLAUDE_MEM_WORKER_PORT: '37777' });
    expect(resolveHarnessAuthHeaders('https://worker.example.com')).toEqual({});
    writeSettings({
      CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN,
      CLAUDE_MEM_WORKER_HOST: 'worker.example.com',
      CLAUDE_MEM_WORKER_PORT: '37777',
      CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST: 'other.example.com',
    });
    expect(resolveHarnessAuthHeaders('https://worker.example.com')).toEqual({});
  });
});

// #6390, through the address Pi and DSH actually resolve (no baseUrl argument), not one a
// test hands in: the client must reach the remote worker and carry the token there.
describe('resolveHarnessAuthHeaders with the resolved worker address', () => {
  const REMOTE = 'worker.example.com';
  const remote = { CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN, CLAUDE_MEM_WORKER_HOST: REMOTE, CLAUDE_MEM_WORKER_PORT: '37777' };

  it('sends the token to the named host reached by host and port over plain http', () => {
    writeSettings({ ...remote, CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST: REMOTE });
    expect(resolveHarnessWorkerUrl()).toBe(`http://${REMOTE}:37777`);
    expect(resolveHarnessAuthHeaders()).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
  });

  it('reaches an https CLAUDE_MEM_WORKER_URL instead of downgrading it, and sends the token there', () => {
    writeSettings({ ...remote, CLAUDE_MEM_WORKER_URL: `https://${REMOTE}`, CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST: REMOTE });
    expect(resolveHarnessWorkerUrl()).toBe(`https://${REMOTE}`);
    expect(resolveHarnessAuthHeaders()).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
  });

  it('never sends it to an unnamed host, by host and port or by URL', () => {
    writeSettings(remote);
    expect(resolveHarnessAuthHeaders()).toEqual({});
    writeSettings({ ...remote, CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST: 'other.example.com' });
    expect(resolveHarnessAuthHeaders()).toEqual({});
    writeSettings({ ...remote, CLAUDE_MEM_WORKER_URL: 'https://attacker.example.com', CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST: REMOTE });
    expect(resolveHarnessWorkerUrl()).toBe('https://attacker.example.com');
    expect(resolveHarnessAuthHeaders()).toEqual({});
  });

  // An SSH forward to another machine looks like loopback: still nothing, opt-in or not.
  it('never sends it to a loopback CLAUDE_MEM_WORKER_URL other than this machine\'s worker', () => {
    writeSettings({
      CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN,
      CLAUDE_MEM_WORKER_PORT: '37777',
      CLAUDE_MEM_WORKER_URL: 'http://127.0.0.1:9',
      CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST: '127.0.0.1',
    });
    expect(resolveHarnessWorkerUrl()).toBe('http://127.0.0.1:9');
    expect(resolveHarnessAuthHeaders()).toEqual({});
  });

  it('refuses a plain-http CLAUDE_MEM_WORKER_URL to another host instead of falling back, as the hooks do', () => {
    writeSettings({ ...remote, CLAUDE_MEM_WORKER_URL: `http://${REMOTE}:37777`, CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST: REMOTE });
    expect(() => resolveHarnessWorkerUrl()).toThrow('https');
  });

  it('ignores an environment opt-in', () => {
    writeSettings(remote);
    process.env.CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST = REMOTE;
    expect(resolveHarnessAuthHeaders()).toEqual({});
  });
});
