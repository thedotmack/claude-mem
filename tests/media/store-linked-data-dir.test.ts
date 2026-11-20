import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { MediaStore } from '../../src/services/media/store.js';
import { ingestObservation, setIngestContext } from '../../src/services/worker/http/shared.js';
import type { MediaAttachmentRef } from '../../src/shared/media-contract.js';

let directory: string;
let sessions: SessionStore | undefined;
let media: MediaStore;
let queued: Array<{ mediaRefs?: MediaAttachmentRef[] }>;
let previousCapture: string | undefined;

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'media-linked-data-')));
  previousCapture = process.env.CLAUDE_MEM_MEDIA_CAPTURE_ENABLED;
  process.env.CLAUDE_MEM_MEDIA_CAPTURE_ENABLED = 'true';
  queued = [];
});
afterEach(() => {
  sessions?.close();
  sessions = undefined;
  if (previousCapture === undefined) delete process.env.CLAUDE_MEM_MEDIA_CAPTURE_ENABLED;
  else process.env.CLAUDE_MEM_MEDIA_CAPTURE_ENABLED = previousCapture;
  rmSync(directory, { recursive: true, force: true });
});

function openStore(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  sessions = new SessionStore(join(dataDir, 'memory.db'));
  media = new MediaStore(sessions.db, dataDir);
  setIngestContext({
    dbManager: { getSessionStore: () => sessions!, getMediaStore: () => media } as any,
    sessionManager: { queueObservation: (_id: number, observation: typeof queued[number]) => queued.push(observation) } as any,
    eventBroadcaster: { broadcastObservationQueued: () => {} } as any,
    ensureGeneratorRunning: async () => {},
  });
}

async function capture(): Promise<MediaAttachmentRef[]> {
  const png = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#123456' } }).png().toBuffer();
  const result = await ingestObservation({
    contentSessionId: 'linked-data-session', platformSource: 'claude',
    toolName: 'mcp__browser__screenshot', toolUseId: 'linked-data-screenshot',
    toolInput: {}, toolResponse: { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] },
    cwd: directory,
  });
  expect(result.ok).toBe(true);
  return queued.at(-1)!.mediaRefs ?? [];
}

for (const nested of [false, true]) {
  it(`captures and reopens media with a linked ${nested ? 'ancestor' : 'configured data directory'}`, async () => {
    const physical = join(directory, 'physical');
    const linked = join(directory, 'linked');
    mkdirSync(physical);
    symlinkSync(physical, linked, 'dir');
    const dataDir = nested ? join(linked, 'nested', 'data') : linked;
    openStore(dataDir);

    const refs = await capture();
    expect(refs).toHaveLength(1);
    const id = refs[0]!.id;
    expect(media.getMetadata(id).state).toBe('ready');
    const before = await media.readVariant(id, 'viewer');
    expect((await sharp(before).metadata()).format).toBe('webp');

    sessions!.close();
    sessions = undefined;
    openStore(dataDir);
    // A fresh reader has not performed capture or periodic reconciliation.
    expect(await media.readVariant(id, 'viewer')).toEqual(before);
    expect((await sharp(await media.readVariant(id, 'llm')).metadata()).format).toBe('webp');
    expect(await capture()).toEqual(refs);
    expect(sessions!.db.query('SELECT COUNT(*) AS n FROM media_attachments').get()).toEqual({ n: 1 });
  });
}

for (const component of ['media-v1', 'media-v1/.tmp']) {
  it(`still rejects a symlink at ${component} below the configured boundary`, async () => {
    const dataDir = join(directory, 'data');
    openStore(dataDir);
    const outside = join(directory, 'outside');
    mkdirSync(outside);
    if (component.endsWith('/.tmp')) mkdirSync(join(dataDir, 'media-v1'));
    symlinkSync(outside, join(dataDir, component), 'dir');

    expect(await capture()).toEqual([]);
    expect(sessions!.db.query('SELECT COUNT(*) AS n FROM media_attachments').get()).toEqual({ n: 0 });
  });
}

it('still rejects a symlink replacing a retained attachment directory', async () => {
  openStore(join(directory, 'data'));
  const [ref] = await capture();
  expect(ref).toBeDefined();
  const attachmentDir = join(media.root, ref!.id);
  rmSync(attachmentDir, { recursive: true });
  const outside = join(directory, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, attachmentDir, 'dir');
  await expect(media.readVariant(ref!.id, 'viewer')).rejects.toMatchObject({ code: 'unsupported_source' });
});
