import { describe, expect, it } from 'bun:test';
import { runRecoveryCommand } from '../../../scripts/sync-recovery.ts';

describe('recovery CLI', () => {
  it('refuses external URLs, credentials and endpoint paths before any request', async () => {
    let requests = 0;
    const io = { fetch: async () => { requests++; return Response.json({}); }, readJson: async () => ({}) };
    for (const url of ['https://127.0.0.1', 'http://cloud.test', 'http://u:p@localhost', 'http://localhost/other', 'http://localhost?x=1']) {
      await expect(runRecoveryCommand(['--worker', url, 'inventory'], io as any)).rejects.toThrow('loopback HTTP');
    }
    expect(requests).toBe(0);
  });

  it('preview is one read-only request and never creates or resumes a job', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const scope = { project: 'fixture', from: '2020-01-01T00:00:00Z', to: '2021-01-01T00:00:00Z', kinds: ['prompt'] };
    const result = await runRecoveryCommand(['preview', '--scope', 'scope.json'], {
      fetch: (async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ previewToken: 'review-only' }); }) as typeof fetch,
      readJson: async () => scope,
    });
    expect(result).toEqual({ previewToken: 'review-only' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toEndWith('/recovery/preview');
    expect(JSON.parse(calls[0].init!.body as string)).toEqual(scope);
  });

  it('creates only the reviewed scope then requires a separate epoch-bound resume', async () => {
    const bodies: unknown[] = [];
    const io = {
      fetch: (async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return Response.json({}); }) as typeof fetch,
      readJson: async () => ({ scope: { project: 'fixture' }, previewToken: 'bound-hash', ignored: 'not forwarded' }),
    };
    await runRecoveryCommand(['create', '--preview', 'preview.json'], io);
    await runRecoveryCommand(['resume', 'job-id', '--epoch', '9007199254740993'], io);
    expect(bodies).toEqual([{ scope: { project: 'fixture' }, previewToken: 'bound-hash' }, { action: 'resume', expectedEpoch: '9007199254740993' }]);
    await expect(runRecoveryCommand(['resume', 'job-id'], io)).rejects.toThrow('Missing --epoch');
  });

  it('does not forward review bodies or unsupported arguments into repair', async () => {
    let sent: unknown;
    const io = {
      fetch: (async (_url, init) => { sent = JSON.parse(init!.body as string); return Response.json({}); }) as typeof fetch,
      readJson: async () => ({ previewToken: 'exact-review', body: 'never replay this' }),
    };
    await runRecoveryCommand(['conflict-apply', '--review', 'review.json'], io);
    expect(sent).toEqual({ previewToken: 'exact-review' });
    await expect(runRecoveryCommand(['inventory', '--force'], io)).rejects.toThrow('Unexpected');
  });

  it('refuses redirects before forwarding a scope or review token to another endpoint', async () => {
    let forwarded = 0;
    const target = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { forwarded++; return Response.json({}); } });
    const redirect = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, {
      status: 307, headers: { Location: `http://127.0.0.1:${target.port}/unexpected` },
    }) });
    try {
      await expect(runRecoveryCommand(['--worker', `http://127.0.0.1:${redirect.port}`, 'create', '--preview', 'review.json'], {
        fetch, readJson: async () => ({ scope: { project: 'private' }, previewToken: 'private-review' }),
      })).rejects.toThrow();
      expect(forwarded).toBe(0);
    } finally { redirect.stop(true); target.stop(true); }
  });
});
