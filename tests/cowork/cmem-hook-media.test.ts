// Phase 5: Cowork hook-client image capture (cowork/scripts/cmem-hook.mjs).
// Runs the real dependency-free script under node against a mocked cmem.ai.
// Images are generated; the shapes copy the native fixtures used by the local
// capture tests (tests/media/capture.test.ts). HOME is a project-local
// .scratch directory, never the system temp directory.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const ROOT = join(import.meta.dir, '../..');
const HOOK = join(ROOT, 'cowork/scripts/cmem-hook.mjs');
const SCRATCH = join(ROOT, '.scratch');

interface Received { order: number; path: string; auth: string | null; json?: any; fields?: string[]; manifest?: any; fileType?: string; fileBytes?: Buffer }
let received: Received[] = [];
let uploadStatus = 200;
let ingestStatus = 202;
let server: ReturnType<typeof Bun.serve>;
let home: string;
let png: Buffer;
let jpeg: Buffer;
let webp: Buffer;

beforeAll(async () => {
  const image = (red: number) => sharp({ create: { width: 40, height: 20, channels: 3, background: { r: red, g: 30, b: 60 } } });
  png = await image(200).png().toBuffer();
  jpeg = await image(100).jpeg().toBuffer();
  webp = await image(50).webp().toBuffer();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const record: Received = { order: received.length, path: url.pathname, auth: request.headers.get('authorization') };
      received.push(record);
      if (url.pathname === '/api/observation-media') {
        const form = await request.formData();
        record.fields = Array.from(form.keys());
        record.manifest = JSON.parse(String(form.get('manifest')));
        const file = form.get('canonical') as File;
        record.fileType = file.type;
        record.fileBytes = Buffer.from(await file.arrayBuffer());
        return Response.json(uploadStatus === 200 ? { id: record.manifest.id, state: 'ready' } : { error: 'storage_unavailable' }, { status: uploadStatus });
      }
      if (url.pathname === '/api/hooks/ingest') {
        record.json = await request.json();
        return Response.json({ accepted: 1 }, { status: ingestStatus });
      }
      return new Response('{}', { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  home = realpathSync(mkdtempSync(join(SCRATCH, 'cowork-media-')));
  received = [];
  uploadStatus = 200;
  ingestStatus = 202;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function runHook(input: unknown, env: Record<string, string> = {}): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile('node', [HOOK, 'observation'], {
      env: { PATH: process.env.PATH ?? '', HOME: home, CMEM_API_BASE: `http://127.0.0.1:${server.port}`, CMEM_API_KEY: 'cm_pro_0123456789abcdef0123456789abcdef', CMEM_MEDIA_CAPTURE_ENABLED: 'true', ...env },
      timeout: 30_000,
    }, (error, _stdout, stderr) => error && error.killed ? reject(error) : resolve({ stderr: String(stderr) }));
    child.stdin!.end(JSON.stringify(input));
  });
}

const b64 = (bytes: Buffer) => bytes.toString('base64');
const SHAPES: Record<string, { response: () => unknown; pointer: string; bytes: () => Buffer }> = {
  anthropic_base64: {
    response: () => ({ content: [{ type: 'text', text: 'Took a screenshot.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(png) } }] }),
    pointer: '/tool_response/content/1', bytes: () => png,
  },
  claude_read_base64: {
    response: () => ({ type: 'image', file: { base64: b64(jpeg), type: 'image/jpeg', originalSize: 4096, dimensions: { originalWidth: 40, originalHeight: 20 } } }),
    pointer: '/tool_response', bytes: () => jpeg,
  },
  mcp_base64: {
    response: () => [{ type: 'text', text: 'Browser tab: 1' }, { type: 'image', data: b64(webp), mimeType: 'image/webp' }],
    pointer: '/tool_response/1', bytes: () => webp,
  },
  openai_data_url: {
    response: () => ({ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64(png) } }] }),
    pointer: '/tool_response/content/0', bytes: () => png,
  },
};

function observation(toolResponse: unknown, toolUseId: unknown = 'toolu_01MediaEvent') {
  return { session_id: 'cowork-session', cwd: '/home/claude', tool_name: 'mcp__browser__screenshot', tool_use_id: toolUseId, tool_input: { action: 'screenshot' }, tool_response: toolResponse };
}
const ingests = () => received.filter(record => record.path === '/api/hooks/ingest');
const uploads = () => received.filter(record => record.path === '/api/observation-media');
function expectNoBytes(text: string, bytes: Buffer) {
  expect(text).not.toContain(b64(bytes).slice(0, 40));
  expect(text).not.toContain('data:image');
}

describe('Cowork hook image capture', () => {
  for (const [shape, fixture] of Object.entries(SHAPES)) {
    it(`${shape}: uploads before the first staging and stages a byte-free descriptor`, async () => {
      await runHook(observation(fixture.response()));
      expect(uploads()).toHaveLength(1);
      expect(ingests()).toHaveLength(1);
      const [upload] = uploads();
      expect(upload.order).toBeLessThan(ingests()[0].order);
      expect(upload.auth).toBe('Bearer cm_pro_0123456789abcdef0123456789abcdef');
      expect(upload.fields).toEqual(['manifest', 'canonical']);
      const expected = fixture.bytes();
      expect(Buffer.compare(upload.fileBytes!, expected)).toBe(0);
      expect(upload.manifest.provenance).toEqual({
        version: 1, attachment_id: upload.manifest.id, platform: 'cowork',
        event_identity: { kind: 'platform_event', id: 'toolu_01MediaEvent' },
        source_shape: shape, source_pointer: fixture.pointer, source_index: 0,
        source_sha256: createHash('sha256').update(expected).digest('hex'), recipe: 'screenshot-v1',
      });
      expect(upload.manifest.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      // Pro's unconverted-source shape: no other keys at any level.
      expect(Object.keys(upload.manifest).sort()).toEqual(['canonical', 'encoder', 'id', 'provenance', 'version']);
      expect(upload.manifest.encoder).toBe('source');
      expect(upload.manifest.canonical).toEqual({ sha256: createHash('sha256').update(expected).digest('hex'), width: 40, height: 20, byteLength: expected.length });
      const magicMime = shape === 'claude_read_base64' ? 'image/jpeg' : shape === 'mcp_base64' ? 'image/webp' : 'image/png';
      expect(upload.fileType).toBe(magicMime);
      const staged = ingests()[0].json;
      expect(staged.payload.tool_use_id).toBe('toolu_01MediaEvent');
      expect(staged.payload.tool_response).toContain('"cmem_media":"event1_image1"');
      expectNoBytes(JSON.stringify(staged), expected);
    });
  }

  it('keeps the first four images; a fifth is replaced but never uploaded', async () => {
    const content = Array.from({ length: 5 }, () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(png) } }));
    await runHook(observation({ content }));
    expect(uploads().map(upload => upload.manifest.provenance.source_index)).toEqual([0, 1, 2, 3]);
    const staged = String(ingests()[0].json.payload.tool_response);
    for (const label of ['event1_image1', 'event1_image2', 'event1_image3', 'event1_image4', 'unsupported']) expect(staged).toContain(label);
    expectNoBytes(staged, png);
  });

  it('an upload failure stages the envelope exactly once, text-only; a failed ingest spools no bytes', async () => {
    uploadStatus = 503;
    ingestStatus = 503;
    const { stderr } = await runHook(observation(SHAPES.anthropic_base64.response()));
    // One bounded code; never ids, labels, paths or bytes.
    expect(stderr.trim()).toBe('claude-mem-cowork: media upload failed (storage_unavailable)');
    expect(uploads()).toHaveLength(1);
    expect(ingests()).toHaveLength(1);
    expect(String(ingests()[0].json.payload.tool_response)).toContain('upload_failed');
    const spool = join(home, '.claude-mem', 'cowork-spool.jsonl');
    expect(existsSync(spool)).toBe(true);
    expectNoBytes(readFileSync(spool, 'utf8'), png);
    // A later hook fire flushes the spool as-is: no upload retry, no enrichment resend.
    ingestStatus = 202;
    received = [];
    await runHook(observation('plain text', 'toolu_02Other'));
    expect(uploads()).toHaveLength(0);
    const flushed = ingests().find(record => Array.isArray(record.json.batch));
    expect(flushed?.json.batch).toHaveLength(1);
    expect(String(flushed?.json.batch[0].payload.tool_response)).toContain('upload_failed');
  });

  it('unsupported bytes and a missing event id are stripped and never uploaded', async () => {
    const gif = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');
    await runHook(observation({ content: [{ type: 'image', source: { type: 'base64', media_type: 'image/gif', data: b64(gif) } }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(png) } }] }));
    expect(uploads()).toHaveLength(0);
    expect(String(ingests()[0].json.payload.tool_response)).toContain('unsupported');
    expectNoBytes(String(ingests()[0].json.payload.tool_response), png);

    received = [];
    await runHook(observation(SHAPES.anthropic_base64.response(), null));
    expect(uploads()).toHaveLength(0);
    expect(String(ingests()[0].json.payload.tool_response)).toContain('unsupported');
    expectNoBytes(String(ingests()[0].json.payload.tool_response), png);
  });

  it('header dimensions: lossless WebP and progressive JPEG are read; an over-bound image is never uploaded', async () => {
    const lossless = await sharp({ create: { width: 33, height: 17, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).webp({ lossless: true }).toBuffer();
    const extended = await sharp({ create: { width: 30, height: 12, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).webp({ lossless: false }).toBuffer();
    const progressive = await sharp({ create: { width: 21, height: 9, channels: 3, background: { r: 9, g: 9, b: 9 } } }).jpeg({ progressive: true }).toBuffer();
    const tooWide = await sharp({ create: { width: 8200, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    const blocks = [lossless, extended, progressive, tooWide].map((bytes, index) => ({ type: 'image', data: b64(bytes), mimeType: ['image/webp', 'image/webp', 'image/jpeg', 'image/png'][index] }));
    await runHook(observation(blocks));
    expect(uploads().map(upload => [upload.manifest.canonical.width, upload.manifest.canonical.height])).toEqual([[33, 17], [30, 12], [21, 9]]);
    expect(String(ingests()[0].json.payload.tool_response)).toContain('unsupported');
  });

  it('a local claude-mem capture setting does not enable the Cowork lane', async () => {
    mkdirSync(join(home, '.claude-mem'), { recursive: true });
    await Bun.write(join(home, '.claude-mem', 'settings.json'), JSON.stringify({ CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'true' }));
    await runHook(observation(SHAPES.anthropic_base64.response()), { CMEM_MEDIA_CAPTURE_ENABLED: '' });
    expect(uploads()).toHaveLength(0);
    expect(String(ingests()[0].json.payload.tool_response)).not.toContain('cmem_media');
  });

  it('past the walk bound, remaining image bytes are scrubbed before clean(); text survives', async () => {
    let deep: any = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(png) } };
    for (let level = 0; level < 20; level++) deep = { level, child: deep };
    const response = { content: [{ type: 'text', text: 'deep screenshot follows' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64(png) } }], deep };
    await runHook(observation(response));
    const staged = String(ingests()[0].json.payload.tool_response);
    expect(staged).toContain('deep screenshot follows');
    expect(staged).toContain('{"type":"image","cmem_media":"unsupported"}');
    expectNoBytes(staged, png);
    // The image inside the bound was still captured and uploaded.
    expect(uploads()).toHaveLength(1);
  });

  it('is off by default: no upload and the existing envelope behavior', async () => {
    await runHook(observation(SHAPES.anthropic_base64.response()), { CMEM_MEDIA_CAPTURE_ENABLED: '' });
    expect(uploads()).toHaveLength(0);
    expect(ingests()).toHaveLength(1);
    expect(String(ingests()[0].json.payload.tool_response)).not.toContain('cmem_media');
  });

  it('image-free payloads are unchanged with capture on', async () => {
    const response = { content: [{ type: 'text', text: 'hello' }], nested: { deep: [1, 2, { x: 'y' }] } };
    await runHook(observation(response));
    expect(uploads()).toHaveLength(0);
    expect(ingests()[0].json.payload.tool_response).toBe(JSON.stringify(response));
  });
});
