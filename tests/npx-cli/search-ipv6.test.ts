import { describe, expect, it } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function searchAgainst(host: string, listenHost: string, settingsOnly = false): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-search-ipv6-'));
  const urls: string[] = [];
  const result = { observations: [{ id: 7, title: 'Native search result' }] };
  const server = http.createServer((request, response) => {
    urls.push(request.url ?? '');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, listenHost, resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const modulePath = join(import.meta.dir, '../../src/npx-cli/commands/runtime.ts');
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_MEM_DATA_DIR: root, CLAUDE_CONFIG_DIR: root,
      CLAUDE_MEM_TELEMETRY: '0', DO_NOT_TRACK: '1' };
    delete env.CLAUDE_MEM_WORKER_HOST;
    delete env.CLAUDE_MEM_WORKER_PORT;
    if (settingsOnly) {
      writeFileSync(join(root, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_WORKER_HOST: host, CLAUDE_MEM_WORKER_PORT: String(port),
      }));
    } else {
      env.CLAUDE_MEM_WORKER_HOST = host;
      env.CLAUDE_MEM_WORKER_PORT = String(port);
    }
    const child = Bun.spawn({
      cmd: [process.execPath, '-e', `import { runSearchCommand } from ${JSON.stringify(modulePath)};
        const nativeFetch = globalThis.fetch;
        globalThis.fetch = ((url, ...rest) => {
          if (new URL(String(url)).port !== ${JSON.stringify(String(port))}) {
            throw new Error('Refusing a request outside the isolated fixture listener');
          }
          return nativeFetch(url, ...rest);
        });
        await runSearchCommand(['query', '&', '日本語']);`],
      cwd: join(import.meta.dir, '../..'),
      env,
      stdout: 'pipe', stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(stdout)).toEqual(result);
    expect(urls).toEqual(['/api/search?query=' + encodeURIComponent('query & 日本語')]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

describe('npx search native worker host URLs', () => {
  it('searches an unbracketed IPv6 loopback host', async () => {
    await searchAgainst('::1', '::1');
  });
  it('preserves an already bracketed IPv6 host', async () => {
    await searchAgainst('[::1]', '::1');
  });
  it('loads the saved custom worker host and port when environment overrides are absent', async () => {
    await searchAgainst('127.0.0.1', '127.0.0.1', true);
  });
  it('preserves IPv4 and query encoding', async () => {
    await searchAgainst('127.0.0.1', '127.0.0.1');
  });
});
