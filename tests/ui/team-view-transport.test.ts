import { describe, expect, it } from 'bun:test';
import { readTeamResource, sharingDescription } from '../../src/ui/work-view/team-view.js';

describe('shared workspace transport', () => {
  it('distinguishes an empty sharing scope from sharing every project', () => {
    expect(sharingDescription({ broadcasting: true, projects: [] })).toContain('no projects selected');
    expect(sharingDescription({ broadcasting: true, projects: null })).toContain('all projects');
    expect(sharingDescription({ broadcasting: true, projects: ['one'] })).toContain('one');
    expect(sharingDescription({ broadcasting: false, projects: null })).toContain('Sharing from this computer is off');
  });
  it('retains authorization failure status without exposing an HTML error body', async () => {
    try {
      await readTeamResource('/board', undefined, { fetcher: async () => new Response('<html>private diagnostic</html>', { status: 403 }) });
      throw new Error('Expected refusal');
    } catch (error) {
      expect((error as Error & { status: number }).status).toBe(403);
      expect((error as Error).message).toBe('Shared work could not be loaded.');
    }
  });

  it('times out a response whose headers arrive but body stalls', async () => {
    const fetcher = async (_path: string, options: { signal: AbortSignal }) => new Response(new ReadableStream({
      start(controller) { options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true }); },
    }));
    await expect(readTeamResource('/board', undefined, { timeoutMs: 10, fetcher })).rejects.toThrow('team connection timed out');
  });

  it('preserves cancellation when switching away from the shared workspace', async () => {
    const controller = new AbortController();
    const fetcher = async (_path: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    const pending = readTeamResource('/board', controller.signal, { fetcher });
    controller.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });

  it('rejects an unreadable successful reply rather than claiming disconnection', async () => {
    await expect(readTeamResource('/status', undefined, { fetcher: async () => new Response('not JSON') })).rejects.toThrow('could not be read');
  });
});
