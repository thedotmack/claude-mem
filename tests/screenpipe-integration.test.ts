import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from '../plugin/skills/screenpipe/screenpipe.mjs';

const searchArgs = ['search', '--start', '2026-10-07T09:00:00-07:00', '--end', '2026-10-07T10:00:00-07:00'];
const servers: ReturnType<typeof Bun.serve>[] = [];
const dirs: string[] = [];
function serve(fetch: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch });
  servers.push(server);
  return server.url.origin;
}
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('packaged Screenpipe integration', () => {
  it('queries a bounded window, forwards auth and preserves provenance without media', async () => {
    const url = serve(req => {
      const url = new URL(req.url);
      expect(req.method).toBe('GET');
      expect(url.pathname).toBe('/search');
      expect(url.searchParams.get('start_time')).toBe('2026-10-07T16:00:00.000Z');
      expect(url.searchParams.get('end_time')).toBe('2026-10-07T17:00:00.000Z');
      expect(url.searchParams.get('q')).toBe('design & review');
      expect(url.searchParams.get('app_name')).toBe('Browser');
      expect(url.searchParams.get('include_frames')).toBe('false');
      expect(req.headers.get('Authorization')).toBe('Bearer test-key');
      return Response.json({ data: [
        { type: 'OCR', content: { frame_id: 10, timestamp: '2026-10-07T16:30:00Z', text: 'Decision '.repeat(300), app_name: 'Browser', window_name: 'Design', file_path: '/private/video.mp4', frame: 'binary' } },
        { type: 'Audio', content: { chunk_id: 20, timestamp: '2026-10-07T16:31:00Z', transcription: 'Ship Friday' } },
      ], pagination: { total: 3 } });
    });
    const result = await run([...searchArgs, '--query', 'design & review', '--app', 'Browser', '--type', 'all', '--limit', '2'], { SCREENPIPE_URL: url, SCREENPIPE_API_KEY: 'test-key' });
    expect(result.records[0]).toMatchObject({ id: 10, type: 'OCR', timestamp: '2026-10-07T16:30:00Z', app: 'Browser', truncated: true });
    expect(result.records[0].text).toHaveLength(2000);
    expect(result.records[1]).toMatchObject({ id: 20, type: 'Audio', text: 'Ship Friday' });
    expect(JSON.stringify(result)).not.toContain('/private/video.mp4');
    expect(result.next_offset).toBe(2);
  });

  it('reports empty and unsupported records without inventing content', async () => {
    const url = serve(() => Response.json({ data: [{ type: 'Input', content: { text: 'typing' } }], pagination: { total: 1 } }));
    expect(await run(searchArgs, { SCREENPIPE_URL: url })).toMatchObject({ records: [], omitted: 1, next_offset: null });
    const empty = serve(() => Response.json({ data: [], pagination: { total: 0 } }));
    expect(await run(searchArgs, { SCREENPIPE_URL: empty })).toMatchObject({ records: [], omitted: 0, total: 0 });
  });

  it('rejects invalid scopes and remote service URLs before requesting data', async () => {
    for (const flags of [[], ['--start', 'yesterday', '--end', 'today'], [...searchArgs.slice(1), '--limit', '51'], [...searchArgs.slice(1), '--offset', '-1']]) {
      await expect(run(['search', ...flags])).rejects.toThrow();
    }
    for (const url of ['https://example.com', 'http://127.0.0.1.evil.test', 'http://user:secret@localhost:3030', 'http://localhost:3030/private']) {
      await expect(run(searchArgs, { SCREENPIPE_URL: url })).rejects.toThrow('local HTTP origin');
    }
  });

  it('reports HTTP failures without exposing response bodies or following redirects', async () => {
    for (const status of [401, 403, 500]) {
      const url = serve(() => new Response('private body', { status }));
      await expect(run(searchArgs, { SCREENPIPE_URL: url })).rejects.toThrow(`HTTP ${status}`);
    }
    let redirected = false;
    const target = serve(() => { redirected = true; return Response.json({ data: [] }); });
    const url = serve(() => Response.redirect(target));
    await expect(run(searchArgs, { SCREENPIPE_URL: url })).rejects.toThrow('request failed');
    expect(redirected).toBe(false);
    const malformed = serve(() => Response.json({ unexpected: [] }));
    await expect(run(searchArgs, { SCREENPIPE_URL: malformed })).rejects.toThrow('missing data array');
  });

  it('saves only the selected note through the worker API and returns its receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'screenpipe-skill-'));
    dirs.push(dir);
    const file = join(dir, 'note.md');
    await writeFile(file, 'Ship Friday. Source: Screenpipe Audio #20, 2026-10-07T16:31:00Z.');
    const url = serve(async req => {
      expect(new URL(req.url).pathname).toBe('/api/memory/save');
      expect(req.method).toBe('POST');
      expect(await req.json()).toEqual({
        text: 'Ship Friday. Source: Screenpipe Audio #20, 2026-10-07T16:31:00Z.',
        title: 'Release', project: 'demo', metadata: { source: 'screenpipe' },
      });
      return Response.json({ success: true, id: 42, project: 'demo' });
    });
    const args = ['save', '--file', file, '--title', 'Release', '--project', 'demo', '--worker-url', url];
    expect(await run(args)).toMatchObject({ success: true, id: 42 });
    const failed = serve(() => Response.json({ success: false }));
    await expect(run([...args.slice(0, -1), failed])).rejects.toThrow('did not confirm');
    await writeFile(file, '');
    await expect(run(args)).rejects.toThrow('1..65536 bytes');
  });

  it('runs under Node and emits actionable CLI errors on stderr with a failing exit code', async () => {
    const url = serve(() => new Response('sensitive response body', { status: 401 }));
    const proc = Bun.spawn(['node', resolve('plugin/skills/screenpipe/screenpipe.mjs'), ...searchArgs], {
      env: { ...process.env, SCREENPIPE_URL: url, SCREENPIPE_API_KEY: 'secret-token' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Screenpipe returned HTTP 401');
    expect(stderr).not.toContain('secret-token');
    expect(stderr).not.toContain('sensitive response body');
  });
});
