import { expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDefaultWorkerPort } from '../../src/shared/install-port.js';

const hook = join(import.meta.dir, '../../cowork/scripts/cmem-hook.mjs');

it('shows the local worker port for the configured data folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cowork-viewer-port-'));
  let data = join(root, 'custom-data');
  const home = join(root, 'home');
  while (process.platform === 'win32' && getDefaultWorkerPort(data) === 37700) data += '-x';
  mkdirSync(data);
  mkdirSync(home);
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const run = (extra: Record<string, string> = {}) => new Promise<string>((resolve, reject) => {
    const child = execFile('node', [hook, 'context'], {
      env: {
        PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '',
        HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, 'claude'),
        CLAUDE_MEM_DATA_DIR: data, CMEM_API_BASE: `http://127.0.0.1:${port}`, CMEM_API_KEY: 'fixture-key', ...extra,
      },
      timeout: 15_000,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin!.end(JSON.stringify({ session_id: `viewer-${Math.random()}`, cwd: root, source: 'startup' }));
  });
  try {
    const expected = getDefaultWorkerPort(data);
    expect(await run()).toContain(`http://localhost:${expected}`);
    writeFileSync(join(data, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '37777' }));
    expect(await run()).toContain('http://localhost:37777');
    writeFileSync(join(data, 'settings.json'), '\uFEFF' + JSON.stringify({ env: { CLAUDE_MEM_WORKER_PORT: '38123' } }));
    expect(await run()).toContain('http://localhost:38123');
    expect(await run({ CLAUDE_MEM_WORKER_PORT: '38124' })).toContain('http://localhost:38124');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
