import { describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(import.meta.dir, '../../cowork/scripts/cmem-hook.mjs');

describe('Cowork remote inference delivery', () => {
  it.each(['observation', 'session-init', 'summarize'])('%s waits for a 400 ms response without retrying or spooling', async event => {
    const home = mkdtempSync(join(tmpdir(), 'cowork-delivery-'));
    const received: Array<{ body: any; response: ServerResponse }> = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        received.push({ body: JSON.parse(body), response });
        timers.push(setTimeout(() => {
          response.writeHead(202, { 'content-type': 'application/json' });
          response.end('{"accepted":1}');
        }, 400));
      });
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      await new Promise<void>((resolve, reject) => {
        const child = execFile('node', [HOOK, event], {
          env: {
            PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home,
            CMEM_API_BASE: `http://127.0.0.1:${port}`, CMEM_API_KEY: 'test-key',
          },
          timeout: 10_000,
        }, error => error ? reject(error) : resolve());
        child.stdin!.end(JSON.stringify({
          session_id: 'slow-remote', tool_name: 'Bash', tool_use_id: 'tu_slow', prompt: 'hello',
        }));
      });
      expect(received.map(record => record.body.event)).toEqual([event]);
      expect(received[0].response.writableFinished).toBe(true);
      expect(existsSync(join(home, '.claude-mem/cowork-spool.jsonl'))).toBe(false);
    } finally {
      timers.forEach(clearTimeout);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
