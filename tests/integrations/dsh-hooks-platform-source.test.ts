import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WorkerClient } from '../../src/integrations/dsh-plugin/worker.js';
import { applyMemoryHooks } from '../../src/integrations/dsh-plugin/hooks.js';

// The DSH hooks summarize with their configured platformSource; the memories
// they ingest from tool results must carry it too, or they are saved as
// Claude Code's and DSH's own source-filtered context never shows them.
let server: Server | undefined;
afterEach(() => new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve())));

describe('DSH memory hooks', () => {
  it('saves ingested tool results with the configured platformSource', async () => {
    const posts: Array<{ url: string; body: any }> = [];
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        posts.push({ url: req.url ?? '', body: JSON.parse(raw || '{}') });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ success: true, id: 1, title: 't', project: 'proj', message: 'saved' }));
      });
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    const worker = new WorkerClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 2000 });
    const handlers: Record<string, Function> = {};
    applyMemoryHooks({ on: (event: string, handler: Function) => { handlers[event] = handler; } } as any, worker, {
      platformSource: 'dsh', injectContext: false, ingest: true, summarize: false, toolFilter: { names: ['read'] },
    } as any);

    const agent = { session: { id: 's1', header: { cwd: '/tmp/proj' } } };
    await handlers['tools/post-execute']({ name: 'read', agent }, { isError: false, content: [{ type: 'text', text: 'file body' }] }, async () => ({}));
    await new Promise(resolve => setTimeout(resolve, 100));

    const save = posts.find(post => post.url === '/api/memory/save');
    expect(save?.body.text).toBe('[read] file body');
    expect(save?.body.metadata).toEqual({ platformSource: 'dsh' });
  });
});
