// Local API token mode (#5141), end to end: the real worker started with the key set, and a
// real hook run against it. Turning the mode on must not quietly break capture, so the hook's
// own write has to get through a guard that refuses the same request without the token.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCAL_API_TOKEN_HEADER } from '../../src/shared/local-api-token.js';

// Booting a real worker is slow; every hook and test in this file gets the longer budget.
setDefaultTimeout(60_000);

const TOKEN = 'e2e-local-api-token';
const entry = path.resolve(import.meta.dir, '../../src/services/worker-service.ts');

let root = '';
let dataDir = '';
let projectDir = '';
let port = 0;
let worker: ReturnType<typeof Bun.spawn> | undefined;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no bound port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

/** No inherited CLAUDE_MEM_* value: one would override the settings file this test writes. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('CLAUDE_MEM_')) env[key] = value;
  }
  return {
    ...env,
    HOME: root,
    CLAUDE_MEM_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    DO_NOT_TRACK: '1',
    CLAUDE_MEM_TELEMETRY: '0',
  };
}

const url = (route: string): string => `http://127.0.0.1:${port}${route}`;
const withToken = { [LOCAL_API_TOKEN_HEADER]: TOKEN };

async function runHook(event: string, payload: Record<string, unknown>) {
  const child = Bun.spawn([process.execPath, entry, 'hook', 'claude-code', event], {
    cwd: projectDir, env: cleanEnv(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, status };
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'cm-local-api-e2e-'));
  dataDir = path.join(root, 'data');
  projectDir = path.join(root, 'project');
  mkdirSync(dataDir);
  mkdirSync(projectDir);
  port = await freePort();
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
    CLAUDE_MEM_WORKER_PORT: String(port),
    // A worker run by hand: hooks must use it and never start another.
    CLAUDE_MEM_WORKER_AUTOSTART: 'false',
    CLAUDE_MEM_CHROMA_ENABLED: 'false',
    CLAUDE_MEM_OBSERVER_ENABLED: 'false',
    CLAUDE_MEM_AUTO_UPDATE: 'false',
    CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN,
  }));

  worker = Bun.spawn([process.execPath, entry, '--daemon'], {
    cwd: projectDir, env: cleanEnv(), stdout: 'ignore', stderr: 'ignore',
  });
  // The worker listens first and opens its database after: routes answer 503 until then.
  // A read that needs the token and succeeds shows both are done.
  for (let attempt = 0; attempt < 120; attempt++) {
    const read = await fetch(url('/api/prompts'), { headers: { [LOCAL_API_TOKEN_HEADER]: TOKEN } }).catch(() => null);
    if (read?.ok) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('the worker did not answer an authenticated read within 30 seconds');
});

afterAll(async () => {
  worker?.kill();
  await worker?.exited;
  rmSync(root, { recursive: true, force: true });
});

describe('a worker started with CLAUDE_MEM_LOCAL_API_TOKEN set', () => {
  it('answers the health probe without the token and refuses everything else without it', async () => {
    expect((await fetch(url('/api/health'))).status).toBe(200);
    expect((await fetch(url('/api/readiness'))).status).toBe(401);
    expect((await fetch(url('/api/prompts'))).status).toBe(401);
    const write = await fetch(url('/api/sessions/init'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentSessionId: 'bare-request', project: 'e2e', prompt: 'must not be stored' }),
    });
    expect(write.status).toBe(401);
  });

  it('takes the token as a header or ?token=, serves the page shell without one, and sets no cookie', async () => {
    // Past the guard is all this asserts: a worker still starting answers readiness 503.
    expect((await fetch(url('/api/readiness'), { headers: withToken })).status).not.toBe(401);
    expect((await fetch(url('/api/prompts'), { headers: withToken })).status).toBe(200);
    const read = await fetch(url(`/api/prompts?token=${TOKEN}`));
    expect(read.status).toBe(200);
    expect(read.headers.get('set-cookie')).toBeNull();
    // The page shell holds no data. A source checkout has no built UI, so it may answer 503:
    // either way it passed the guard. Its scripts send the token on the requests that do.
    const page = await fetch(url('/'));
    expect(page.status).not.toBe(401);
    expect(page.headers.get('set-cookie')).toBeNull();
    expect((await fetch(url('/stream'))).status).toBe(401);
  });

  it('lets `claude-mem start` see it ready, which waits on the token-only readiness route', async () => {
    const startedAt = Date.now();
    const child = Bun.spawn([process.execPath, entry, 'start'], {
      cwd: projectDir, env: cleanEnv(), stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(status).toBe(0);
    expect(stdout).toContain('"status":"ready"');
    expect(stdout).not.toContain('warming');
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it('is written to by a real hook, which sends the token on its own', async () => {
    const prompt = 'E2E prompt: the hook must reach a worker that wants a token';
    const { stdout, stderr, status } = await runHook('session-init', {
      session_id: 'e2e-session-1',
      cwd: projectDir,
      hook_event_name: 'UserPromptSubmit',
      prompt,
    });
    expect(stderr).not.toContain('401');
    expect(status).toBe(0);
    expect(() => JSON.parse(stdout || '{}')).not.toThrow();

    // The write landed: the prompt is in the worker's store, read back with the token.
    const stored = await (await fetch(url('/api/prompts'), { headers: withToken })).json();
    expect(JSON.stringify(stored)).toContain(prompt);
    // And not for a bare reader.
    expect((await fetch(url('/api/prompts'))).status).toBe(401);
  });
});
