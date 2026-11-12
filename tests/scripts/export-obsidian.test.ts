import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPortCache } from '../../src/shared/worker-utils.js';
import { exportObsidianNotes } from '../../scripts/export-obsidian.js';

let directory: string;
let vault: string;
let server: ReturnType<typeof Bun.serve>;
let payload: unknown;
let requests: Array<Record<string, unknown>>;
let workerUrl: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'obsidian export '));
  vault = join(directory, 'chosen vault');
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  payload = [{ id: 42, project: 'selected,project', title: 'A selected decision', narrative: 'Use the amber region.', facts: '["Run the smoke test"]', metadata: 'PRIVATE_METADATA', sdk_session_id: 'PRIVATE_SESSION' }];
  requests = [];
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe('/api/observations/batch');
    requests.push(await request.json() as Record<string, unknown>);
    return Response.json(payload);
  } });
  workerUrl = process.env.CLAUDE_MEM_WORKER_URL;
  process.env.CLAUDE_MEM_WORKER_URL = `http://127.0.0.1:${server.port}`;
  clearPortCache();
});

afterEach(() => {
  server.stop(true);
  if (workerUrl === undefined) delete process.env.CLAUDE_MEM_WORKER_URL;
  else process.env.CLAUDE_MEM_WORKER_URL = workerUrl;
  clearPortCache();
  rmSync(directory, { recursive: true, force: true });
});

const options = () => ({ vault, source: 'test-laptop', project: 'selected,project', ids: [42] });

describe('selected memory export to Obsidian', () => {
  it('exports only selected prose with stable identity and literal project scope', async () => {
    const result = await exportObsidianNotes(options());
    expect(result.created).toEqual([42]);
    expect(result.skipped).toEqual([]);
    expect(requests).toEqual([{ ids: [42], project: 'selected,project', projects: ['selected,project'] }]);
    const note = readFileSync(join(vault, 'Claude-Mem', 'test-laptop', '42.md'), 'utf8');
    expect(note).toContain('claude_mem_id: 42');
    expect(note).toContain('claude_mem_source: "test-laptop"');
    expect(note).toContain('Use the amber region.');
    expect(note).toContain('Run the smoke test');
    expect(note).not.toContain('PRIVATE_');
  });

  it('never overwrites an existing note, its frontmatter or unrelated files on a repeated export', async () => {
    await exportObsidianNotes(options());
    const destination = join(vault, 'Claude-Mem', 'test-laptop', '42.md');
    const edited = '---\ntags: [my-own]\n---\n\nUser edits stay here.\n';
    writeFileSync(destination, edited);
    writeFileSync(join(vault, 'Existing note.md'), 'Original note');
    const result = await exportObsidianNotes(options());
    expect(result.skipped).toEqual([42]);
    expect(result.created).toEqual([]);
    expect(readFileSync(destination, 'utf8')).toBe(edited);
    expect(readFileSync(join(vault, 'Existing note.md'), 'utf8')).toBe('Original note');
    expect(readdirSync(join(vault, 'Claude-Mem', 'test-laptop'))).toEqual(['42.md']);
  });

  it('refuses a cross-project or incomplete response before writing any note', async () => {
    payload = [{ id: 42, project: 'other-project', narrative: 'Private note' }];
    await expect(exportObsidianNotes(options())).rejects.toThrow('selected project');
    payload = [];
    await expect(exportObsidianNotes(options())).rejects.toThrow('not returned');
    expect(existsSync(join(vault, 'Claude-Mem'))).toBe(false);
  });

  it('keeps embedded Markdown and HTML inert, including a backtick-fence breakout', async () => {
    payload = [{ id: 42, project: 'selected,project', title: '---\n<img src="https://example.com/title">', narrative: '```\n![](https://example.com/image)\n<img src="https://example.com/html">\n```' }];
    await exportObsidianNotes(options());
    const note = readFileSync(join(vault, 'Claude-Mem', 'test-laptop', '42.md'), 'utf8');
    expect(note).toContain('````text\n```\n![]');
    expect(note).toEndWith('```\n````\n');
    expect(note).toContain('# Memory 42');
  });

  it('refuses symlinked export directories and does not modify their targets', async () => {
    const outside = join(directory, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(vault, 'Claude-Mem'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(exportObsidianNotes(options())).rejects.toThrow('symlink');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses traversal labels, invalid IDs and a folder that is not an Obsidian vault', async () => {
    await expect(exportObsidianNotes({ ...options(), source: '../outside' })).rejects.toThrow('source');
    await expect(exportObsidianNotes({ ...options(), ids: [NaN] })).rejects.toThrow('IDs');
    await expect(exportObsidianNotes({ ...options(), vault: directory })).rejects.toThrow('.obsidian');
    expect(requests).toEqual([]);
  });

  it('reports unsupported content sizes instead of silently shortening an export', async () => {
    payload = [{ id: 42, project: 'selected,project', narrative: 'x'.repeat(40_000) }];
    await expect(exportObsidianNotes(options())).rejects.toThrow('shorten');
    expect(existsSync(join(vault, 'Claude-Mem'))).toBe(false);
  });
});
