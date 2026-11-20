import { expect, it } from 'bun:test';
import { createServer } from 'node:http';
import { buildNotionChildren, NOTION_PROPERTIES, NotionExporter, type NotionObservationRecord } from '../../src/services/integrations/NotionExporter.js';

for (const shape of ['many-blocks', 'deferred-first-block'] as const) {
  it(`finishes ${shape} after page creation commits but its response connection closes`, async () => {
    const record: NotionObservationRecord = {
      observationId: 42, project: 'export-project', memorySessionId: 'memory', createdAtEpoch: 1000,
      observation: {
        type: 'discovery', title: 'Saved note',
        subtitle: shape === 'deferred-first-block' ? 's'.repeat(10000) : null,
        narrative: shape === 'many-blocks'
          ? Array.from({ length: 230 }, (_, i) => `Paragraph ${i}`).join('\n\n') : '戦'.repeat(170000),
        facts: [], concepts: [], files_read: [], files_modified: [],
      },
    };
    const schema = Object.fromEntries([
      ['Name', { type: 'title' }],
      ...Object.values(NOTION_PROPERTIES).map(({ name, type }) => [name, { type }]),
    ]);
    const pages = new Map<string, unknown[]>();
    const calls: Array<{ method: string; path: string; bytes: number; children: number }> = [];
    let failedAppend = false;
    const server = createServer(async (request, response) => {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      const raw = Buffer.concat(parts).toString();
      const body = raw ? JSON.parse(raw) : undefined;
      const method = request.method!;
      const path = request.url!;
      calls.push({ method, path, bytes: Buffer.byteLength(raw), children: body?.children?.length ?? 0 });
      const reply = (value: unknown, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (method === 'GET' && path === '/v1/databases/database') return reply({ properties: schema });
      if (path === '/v1/databases/database/query') {
        const id = pages.has(body.filter.rich_text.equals) ? 'created-page' : null;
        return reply({ results: id ? [{ id }] : [] });
      }
      if (method === 'POST' && path === '/v1/pages') {
        const key = body.properties['Export Key'].rich_text[0].text.content;
        pages.set(key, body.children);
        // Model the committed create whose HTTP answer was lost. This is a real
        // socket close: fetch must recover through its normal retry path.
        response.destroy();
        return;
      }
      if (method === 'PATCH' && path === '/v1/blocks/created-page/children') {
        if (!failedAppend) { failedAppend = true; return reply({ code: 'service_unavailable' }, 503); }
        pages.get('source:42')!.push(...body.children);
        return reply({ results: [] });
      }
      reply({ error: 'unexpected request' }, 400);
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const sleeps: number[] = [];
    const exporter = new NotionExporter({
      token: 'fixture-token', databaseId: 'database', sourceId: 'source', minRequestIntervalMs: 0,
      sleep: async ms => { sleeps.push(ms); },
      fetchImpl: (url, init) => fetch(`${origin}${new URL(url).pathname}`, init),
    });
    try {
      exporter.enqueue(record);
      await exporter.idle();
      expect(pages.get('source:42')).toEqual(buildNotionChildren(record.observation));
      const creates = calls.filter(call => call.path === '/v1/pages');
      expect(creates).toHaveLength(1);
      expect(creates[0].children).toBe(shape === 'many-blocks' ? 100 : 0);
      expect(sleeps).toEqual([1000, 1000]);
      expect(calls.every(call => call.bytes <= 500000 && call.children <= 100)).toBe(true);

      // A later replay is not recovery of that create. Leave an existing,
      // possibly owner-edited page alone instead of appending its body again.
      pages.set('source:42', ['owner-edited body']);
      const writesBeforeReplay = calls.filter(call => call.path === '/v1/pages' || call.method === 'PATCH').length;
      exporter.enqueue(record);
      await exporter.idle();
      expect(pages.get('source:42')).toEqual(['owner-edited body']);
      expect(calls.filter(call => call.path === '/v1/pages' || call.method === 'PATCH')).toHaveLength(writesBeforeReplay);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
