import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workerModule = new URL('../../src/shared/worker-utils.ts', import.meta.url).href;
const harnessModule = new URL('../../src/integrations/harness-worker.ts', import.meta.url).href;

// Fresh processes give the worker's real cached bind/deadline getters the same
// owned settings file as the Pi/DSH client. No installed worker is started.
async function requestContext(dataDir: string, overrides: Record<string, string> = {}) {
  const env = { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir };
  for (const key of ['CLAUDE_MEM_WORKER_PORT', 'CLAUDE_MEM_WORKER_HOST', 'CLAUDE_MEM_API_TIMEOUT_MS']) delete env[key];
  Object.assign(env, overrides);
  const script = `
    const worker = await import(${JSON.stringify(workerModule)});
    const harness = await import(${JSON.stringify(harnessModule)});
    const info = {
      workerPort: worker.getWorkerPort(), workerHost: worker.getWorkerHost(),
      workerTimeout: worker.getWorkerApiRequestTimeoutMs(),
      harnessUrl: harness.resolveHarnessWorkerUrl(), harnessTimeout: harness.resolveHarnessContextTimeoutMs(),
    };
    // A broken resolver must not send the fixture request to an unrelated
    // process that happens to own the default port.
    if (info.harnessUrl !== 'http://' + info.workerHost + ':' + info.workerPort) {
      console.log(JSON.stringify({ ...info, outcome: 'address_mismatch' }));
      process.exit(0);
    }
    try {
      const text = await harness.createHarnessWorkerClient().context(new URLSearchParams({ cwd: ${JSON.stringify(dataDir)} }));
      console.log(JSON.stringify({ ...info, outcome: 'response', text }));
    } catch (error) {
      console.log(JSON.stringify({ ...info, outcome: 'error', errorName: error.name }));
    }
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], {
    env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, stderr: code === 0 ? '' : stderr }).toEqual({ code: 0, stderr: '' });
  return JSON.parse(stdout.trim());
}

it.each(['flat', 'nested'])('reaches the actual worker bind address with a numeric %s port setting', async shape => {
  const dir = mkdtempSync(join(tmpdir(), 'cmem-harness-number-'));
  const paths: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    paths.push(new URL(request.url).pathname);
    return new Response('memory from the configured worker');
  } });
  try {
    const settings = { CLAUDE_MEM_WORKER_PORT: server.port, CLAUDE_MEM_WORKER_HOST: 'localhost', CLAUDE_MEM_API_TIMEOUT_MS: '1000' };
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(shape === 'nested' ? { env: settings } : settings));
    const result = await requestContext(dir);

    expect(result.workerPort).toBe(server.port);
    expect(result.harnessUrl).toBe(`http://${result.workerHost}:${result.workerPort}`);
    expect(result).toMatchObject({ outcome: 'response', text: 'memory from the configured worker' });
    expect(paths).toEqual(['/api/context/inject']);
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

it('uses the numeric API deadline for a real context request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmem-harness-deadline-'));
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
    requests++;
    await Bun.sleep(800);
    return new Response('late memory');
  } });
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      CLAUDE_MEM_WORKER_PORT: String(server.port), CLAUDE_MEM_API_TIMEOUT_MS: 500,
    }));
    const result = await requestContext(dir);

    expect(requests).toBe(1);
    expect(result).toMatchObject({ outcome: 'error', errorName: 'TimeoutError' });
    expect(result.workerTimeout).toBe(500);
    expect(result.harnessTimeout).toBe(result.workerTimeout);
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

it('retains environment precedence over numeric saved settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmem-harness-override-'));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('override memory') });
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      CLAUDE_MEM_WORKER_PORT: 40500, CLAUDE_MEM_API_TIMEOUT_MS: 500,
    }));
    const result = await requestContext(dir, {
      CLAUDE_MEM_WORKER_PORT: String(server.port), CLAUDE_MEM_API_TIMEOUT_MS: '1000',
    });
    expect(result).toMatchObject({ outcome: 'response', text: 'override memory', workerPort: server.port, workerTimeout: 1000, harnessTimeout: 1000 });
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
