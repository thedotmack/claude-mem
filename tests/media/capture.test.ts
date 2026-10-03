// Phase 2 durable local capture through the real ingest boundary, real SQLite
// v61 schema, real MediaStore and the real Sharp converter. Scratch files live
// in the project-local, gitignored .scratch directory.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { MEDIA_CLEANUP_MAX_ATTEMPTS, MediaStore, mediaEventKey } from '../../src/services/media/store.js';
import { convertMedia } from '../../src/services/media/converter.js';
import { ingestObservation, setIngestContext } from '../../src/services/worker/http/shared.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { MEDIA_LIMITS, MediaError } from '../../src/shared/media-contract.js';
import { captureObservationMedia } from '../../src/services/media/capture.js';
import { logger } from '../../src/utils/logger.js';

const SCRATCH = join(import.meta.dir, '../../.scratch');
const FLAG = 'CLAUDE_MEM_MEDIA_CAPTURE_ENABLED';
const originalFlag = process.env[FLAG];
let png: Buffer;
let pngB64: string;
let otherB64: string;
let dir: string;
let db: Database;
let sessions: SessionStore;
let media: MediaStore;
let queued: any[];
let privatePrompt: boolean;

beforeAll(async () => {
  const make = (r: number) => sharp({ create: { width: 320, height: 180, channels: 4, background: { r, g: 40, b: 90, alpha: 1 } } }).png().toBuffer();
  png = await make(200);
  pngB64 = png.toString('base64');
  otherB64 = (await make(10)).toString('base64');
});
afterAll(() => { if (originalFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = originalFlag; });

function wire(store: SessionStore, mediaStore: MediaStore) {
  setIngestContext({
    dbManager: { getSessionStore: () => store, getMediaStore: () => mediaStore } as any,
    sessionManager: { queueObservation: async (_id: number, observation: any) => { queued.push(observation); } } as any,
    eventBroadcaster: { broadcastObservationQueued: () => {} } as any,
    ensureGeneratorRunning: async () => {},
  });
}

beforeEach(() => {
  process.env[FLAG] = 'true';
  mkdirSync(SCRATCH, { recursive: true });
  dir = realpathSync(mkdtempSync(join(SCRATCH, 'media-capture-')));
  mkdirSync(join(dir, 'project'));
  db = new Database(':memory:');
  sessions = new SessionStore(db);
  privatePrompt = false;
  const getUserPrompt = sessions.getUserPrompt.bind(sessions);
  sessions.getUserPrompt = (...args) => privatePrompt ? '' : getUserPrompt(...args);
  media = new MediaStore(db, join(dir, 'data'));
  queued = [];
  wire(sessions, media);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const anthropic = (data = pngB64) => ({ content: [
  { type: 'text', text: 'Took a screenshot of the viewport.' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
] });
const realReadImageResult = (base64: string, declaredType?: string) => ({
  type: 'image',
  file: {
    base64,
    ...(declaredType === undefined ? {} : { type: declaredType }),
    originalSize: 4096,
    dimensions: { originalWidth: 320, originalHeight: 180, displayWidth: 320, displayHeight: 180 },
  },
});
const SHAPES: Record<string, () => unknown> = {
  anthropic_base64: () => anthropic(),
  // Structure of a real Claude Code Read image result (bytes generated above):
  // the MIME is `file.type`, with originalSize/dimensions beside the bytes.
  claude_read_base64: () => realReadImageResult(pngB64, 'image/png'),
  mcp_base64: () => JSON.stringify({ content: [{ type: 'text', text: 'Browser tab: 1' }, { type: 'image', data: pngB64, mimeType: 'image/png' }] }),
  openai_data_url: () => ({ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + pngB64 } }] }),
};

async function ingest(toolResponse: unknown, overrides: Record<string, unknown> = {}) {
  const result = await ingestObservation({
    contentSessionId: 'media-session', toolName: 'mcp__browser__screenshot', toolInput: { action: 'screenshot' },
    toolResponse, cwd: join(dir, 'project'), platformSource: 'claude', toolUseId: 'toolu_media_1', ...overrides,
  } as any);
  expect(result.ok).toBe(true);
  return queued.at(-1);
}
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
const noBytes = (text: string) => {
  expect(text).not.toContain(pngB64.slice(0, 64));
  expect(text).not.toContain('data:image');
};

describe('capture at the common ingest boundary', () => {
  for (const [shape, response] of Object.entries(SHAPES)) {
    it(`${shape} reaches conversion before stripping, retains both variants and persists no bytes in text`, async () => {
      const observation = await ingest(response());
      expect(observation.mediaRefs).toHaveLength(1);
      const [ref] = observation.mediaRefs;
      expect(ref).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), label: 'event1_image1', inspection: 'uninspected' });
      expect(observation.mediaEventKey).toMatch(/^[0-9a-f]{64}$/);
      const metadata = media.getMetadata(ref.id);
      expect(metadata.state).toBe('ready');
      expect(metadata.viewer!.byteLength).toBeLessThanOrEqual(MEDIA_LIMITS.maxCanonicalBytes);
      expect(metadata.llm!.byteLength).toBeLessThanOrEqual(MEDIA_LIMITS.maxDerivativeBytes);
      for (const variant of ['viewer', 'llm'] as const) {
        expect((await sharp(await media.readVariant(ref.id, variant)).metadata()).format).toBe('webp');
      }
      expect(typeof observation.tool_input).toBe('string');
      expect(typeof observation.tool_response).toBe('string');
      noBytes(observation.tool_response);
      expect(observation.tool_response).toContain(ref.id);
      expect(observation.tool_response).toContain('retained');
      // L3 durable tool_uses backup gets the same descriptors, not the image.
      const row = db.prepare('SELECT tool_input,tool_response FROM tool_uses WHERE tool_use_id=?').get('toolu_media_1') as any;
      noBytes(row.tool_response); noBytes(row.tool_input);
      // No original source bytes or base64 enter any media record.
      const records = JSON.stringify(db.prepare('SELECT * FROM media_attachments').all())
        + JSON.stringify(db.prepare('SELECT * FROM media_events').all());
      noBytes(records);
      expect(readdirSync(join(media.root, ref.id)).sort()).toEqual(['llm.webp', 'viewer.webp']);
    });
  }

  it('preserves captions and unaffected text beside the image', async () => {
    const observation = await ingest(anthropic());
    expect(observation.tool_response).toContain('Took a screenshot of the viewport.');
    expect(observation.tool_input).toContain('screenshot');
  });

  it('disabled capture (the default) stores nothing and leaves an honest disabled descriptor', async () => {
    process.env[FLAG] = 'false';
    const observation = await ingest(anthropic());
    expect(observation.mediaRefs).toBeUndefined();
    expect(observation.mediaFailures).toEqual([{ version: 1, state: 'disabled', code: 'converter_disabled', inspection: 'uninspected', label: 'event1_image1' }]);
    noBytes(observation.tool_response);
    expect(count('SELECT COUNT(*) n FROM media_attachments')).toBe(0);
    expect(existsSync(media.root)).toBe(false);
  });

  it('privacy-gated events are skipped before any pixel is read or stored', async () => {
    privatePrompt = true;
    const result = await ingestObservation({ contentSessionId: 'media-session', toolName: 'x', toolInput: {}, toolResponse: anthropic(), cwd: join(dir, 'project'), platformSource: 'claude', toolUseId: 't' });
    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'private' });
    expect(count('SELECT COUNT(*) n FROM media_attachments')).toBe(0);
    expect(queued).toEqual([]);
  });

  it('a corrupt inline image is rejected with a bounded failure code and no asset', async () => {
    const corrupt = Buffer.from(png.subarray(0, 64)).toString('base64');
    const observation = await ingest(anthropic(corrupt));
    expect(observation.mediaRefs).toBeUndefined();
    expect(observation.mediaFailures[0]).toMatchObject({ state: 'failed', code: 'invalid_image', label: 'event1_image1' });
    expect(count(`SELECT COUNT(*) n FROM media_attachments WHERE state='ready'`)).toBe(0);
  });

  it('an event without a platform identity stays text-only rather than inventing one', async () => {
    const observation = await ingest(anthropic(), { toolUseId: undefined });
    expect(observation.mediaRefs).toBeUndefined();
    expect(observation.mediaFailures[0]).toMatchObject({ code: 'unsupported_source' });
  });
});

describe('trusted Read file locators', () => {
  const readEvent = (filePath: string, toolName = 'Read') => ingest({ type: 'image', file: { path: filePath } }, { toolName, toolInput: { file_path: filePath } });

  it('captures a regular project file, and the canonical survives source removal with a rebuildable derivative', async () => {
    const source = join(dir, 'project', 'shot.png');
    writeFileSync(source, png);
    const observation = await readEvent(source);
    expect(observation.mediaRefs).toHaveLength(1);
    const id = observation.mediaRefs[0].id;
    const provenance = JSON.parse((db.prepare('SELECT provenance FROM media_attachments WHERE id=?').get(id) as any).provenance);
    expect(provenance).toMatchObject({ source_shape: 'trusted_tool_file', source_locator: { kind: 'local_file', path: source } });
    rmSync(source);
    const canonical = await media.readVariant(id, 'viewer');
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(media.getMetadata(id).viewer!.sha256);
    // Rebuild the inference derivative from the retained canonical alone.
    const rebuilt = await convertMedia(canonical, 'image/webp', 'screenshot-v1');
    expect(rebuilt.llm.byteLength).toBeLessThanOrEqual(MEDIA_LIMITS.maxDerivativeBytes);
    expect([rebuilt.llm.width, rebuilt.llm.height]).toEqual([320, 180]);
  });

  it('rejects symlinks, traversal outside the project, mismatched input and non-Read tools', async () => {
    const outside = join(dir, 'outside.png');
    writeFileSync(outside, png);
    symlinkSync(outside, join(dir, 'project', 'link.png'));
    writeFileSync(join(dir, 'project', 'ok.png'), png);
    const cases: Array<[unknown, Record<string, unknown>]> = [
      [{ type: 'image', file: { path: join(dir, 'project', 'link.png') } }, { toolName: 'Read', toolInput: { file_path: join(dir, 'project', 'link.png') } }],
      [{ type: 'image', file: { path: '../outside.png' } }, { toolName: 'Read', toolInput: { file_path: '../outside.png' } }],
      [{ type: 'image', file: { path: outside } }, { toolName: 'Read', toolInput: { file_path: outside } }],
      [{ type: 'image', file: { path: join(dir, 'project', 'ok.png') } }, { toolName: 'Read', toolInput: { file_path: join(dir, 'project', 'other.png') } }],
      [{ type: 'image', file: { path: join(dir, 'project', 'ok.png') } }, { toolName: 'Bash', toolInput: { file_path: join(dir, 'project', 'ok.png') } }],
      [{ type: 'image', file: { path: join(dir, 'project') } }, { toolName: 'Read', toolInput: { file_path: join(dir, 'project') } }],
    ];
    for (const [index, [response, overrides]] of cases.entries()) {
      const observation = await ingest(response, { ...overrides, toolUseId: 'toolu_file_' + index });
      expect(observation.mediaRefs).toBeUndefined();
      expect(observation.mediaFailures[0].state).toBe('failed');
      expect(['unsupported_source', 'source_too_large']).toContain(observation.mediaFailures[0].code);
    }
    expect(count('SELECT COUNT(*) n FROM media_attachments')).toBe(0);
  });
});

describe('durable identity, replay and restart', () => {
  it('repeated identical events and a restarted store reuse the same attachment and files', async () => {
    const first = (await ingest(anthropic())).mediaRefs[0];
    const second = (await ingest(anthropic())).mediaRefs[0];
    expect(second).toEqual(first);
    // Restart: new process state over the same database and DATA_DIR.
    const restarted = new MediaStore(db, join(dir, 'data'));
    wire(sessions, restarted);
    const third = (await ingest(anthropic())).mediaRefs[0];
    expect(third).toEqual(first);
    expect(count('SELECT COUNT(*) n FROM media_attachments')).toBe(1);
    expect(count('SELECT COUNT(*) n FROM media_events')).toBe(1);
    expect(readdirSync(restarted.root).filter(name => name !== '.tmp')).toEqual([first.id]);
  });

  it('replay keys derive from platform event identity only, never RAM buffer IDs', async () => {
    const observation = await ingest(anthropic());
    const identity = { kind: 'platform_event', id: createHash('sha256').update(JSON.stringify(['claude-code', 'media-session', 'toolu_media_1'])).digest('hex') };
    expect(observation.mediaEventKey).toBe(mediaEventKey('claude-code', identity as any));
    const event = db.prepare('SELECT event_identity FROM media_events').get() as any;
    expect(JSON.parse(event.event_identity)).toEqual(identity);
    // Real SessionManager buffer assigns a RAM id; it appears in no media row.
    const manager = new SessionManager(null as any);
    (manager as any).sessions.set(1, { sessionDbId: 1, claimedMessageIds: [], abortController: new AbortController() });
    await manager.queueObservation(1, { ...observation });
    const claimed = manager.claimNextObservation(1, () => true)!;
    expect(claimed.mediaRefs).toEqual(observation.mediaRefs);
    expect(typeof claimed.tool_response).toBe('string');
    const replayRow = db.prepare('SELECT replay_key FROM media_attachments').get() as any;
    expect(replayRow.replay_key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(db.prepare('SELECT * FROM media_events').all())).not.toContain(`"${claimed._persistentId}"`);
  });

  it('identical bytes in a different event keep distinct event provenance', async () => {
    const first = (await ingest(anthropic())).mediaRefs[0];
    const other = (await ingest(anthropic(), { toolUseId: 'toolu_media_2' })).mediaRefs[0];
    expect(other.id).not.toBe(first.id);
  });

  it('a replay whose bytes changed for the same event/source is rejected, not silently re-pointed', async () => {
    const first = (await ingest(anthropic())).mediaRefs[0];
    const changed = await ingest(anthropic(otherB64));
    expect(changed.mediaRefs).toBeUndefined();
    expect(changed.mediaFailures[0]).toMatchObject({ code: 'checksum_mismatch' });
    expect(media.getMetadata(first.id).state).toBe('ready');
    expect(count('SELECT COUNT(*) n FROM media_attachments')).toBe(1);
  });
});

describe('interruption, deletion and cleanup', () => {
  it('an interrupted conversion is reconciled, its temporary files removed, then replay succeeds with the same ID', async () => {
    let release!: () => void;
    const hung = new MediaStore(db, join(dir, 'data'), async () => {
      // Simulate the process dying mid-conversion: leave a staged temp dir.
      const pending = (db.prepare(`SELECT id FROM media_attachments WHERE state='converting'`).get() as any).id;
      mkdirSync(join(hung.root, '.tmp', pending + '-crashed'), { recursive: true });
      writeFileSync(join(hung.root, '.tmp', pending + '-crashed', 'viewer.webp'), 'partial');
      await new Promise<void>(resolve => { release = resolve; });
      throw new MediaError('storage_unavailable');
    });
    wire(sessions, hung);
    const inFlight = ingest(anthropic());
    await Bun.sleep(50);
    const id = (db.prepare(`SELECT id FROM media_attachments`).get() as any).id;
    expect(media.getMetadata(id).state).toBe('converting');
    // "Restart": a new store reconciles after the conversion lease expires.
    expect(readdirSync(join(media.root, '.tmp'))).toHaveLength(1);
    media.reconcile(Date.now() + 60_000);
    // One pass marks the abandoned conversion failed, queues durable cleanup
    // and drains it, removing the staged temporary directory.
    expect(media.getMetadata(id)).toMatchObject({ state: 'failed', failureCode: 'conversion_timeout' });
    expect(readdirSync(join(media.root, '.tmp'))).toEqual([]);
    expect(count('SELECT COUNT(*) n FROM media_cleanup_jobs')).toBe(0);
    release();
    await inFlight;
    wire(sessions, media);
    const replay = (await ingest(anthropic())).mediaRefs[0];
    expect(replay.id).toBe(id);
    expect(media.getMetadata(id).state).toBe('ready');
    // The observer queue was never resurrected by reconciliation.
    expect(queued.filter(observation => observation.mediaRefs)).toHaveLength(1);
  });

  it('a crash between atomic publish and the ready commit leaves no orphan after reconciliation', async () => {
    const ref = (await ingest(anthropic())).mediaRefs[0];
    db.prepare(`UPDATE media_attachments SET state='converting',variants=NULL,lease_until=1 WHERE id=?`).run(ref.id);
    media.reconcile();
    media.reconcile();
    expect(existsSync(join(media.root, ref.id))).toBe(false);
    expect(media.getMetadata(ref.id).state).toBe('failed');
  });

  it('session deletion queues cleanup before tombstoning, and cleanup retries until files are physically removed', async () => {
    const ref = (await ingest(anthropic())).mediaRefs[0];
    const sessionDbId = (db.prepare('SELECT session_db_id FROM media_events').get() as any).session_db_id;
    db.prepare('DELETE FROM sdk_sessions WHERE id=?').run(sessionDbId);
    expect(() => media.getMetadata(ref.id)).toThrow('media_not_found');
    expect(count('SELECT COUNT(*) n FROM media_cleanup_jobs')).toBe(1);
    // Storage failure: an unexpected symlink in place of the asset directory.
    const assetDir = join(media.root, ref.id);
    rmSync(assetDir, { recursive: true });
    mkdirSync(join(dir, 'elsewhere'));
    writeFileSync(join(dir, 'elsewhere', 'keep.txt'), 'not ours');
    symlinkSync(join(dir, 'elsewhere'), assetDir, 'dir');
    const now = Date.now();
    media.reconcile(now);
    expect(db.prepare('SELECT attempts,last_error FROM media_cleanup_jobs').get()).toEqual({ attempts: 1, last_error: 'storage_unavailable' });
    expect(existsSync(join(dir, 'elsewhere', 'keep.txt'))).toBe(true);
    media.reconcile(now + 1); // before retry_at: no attempt
    expect((db.prepare('SELECT attempts FROM media_cleanup_jobs').get() as any).attempts).toBe(1);
    rmSync(assetDir);
    mkdirSync(assetDir);
    media.reconcile(now + 31_000);
    expect(count('SELECT COUNT(*) n FROM media_cleanup_jobs')).toBe(0);
    expect(existsSync(assetDir)).toBe(false);
  });

  it('a shared asset linked by two observations and its event survives partial deletion', async () => {
    const observation = await ingest(anthropic());
    const ref = observation.mediaRefs[0];
    db.prepare(`UPDATE sdk_sessions SET memory_session_id='m' WHERE content_session_id='media-session'`).run();
    for (const id of [1, 2]) {
      db.prepare(`INSERT INTO observations(id,memory_session_id,project,type,title,created_at,created_at_epoch) VALUES(?,'m','p','discovery','t','2026-10-02T00:00:00Z',1)`).run(id);
      media.linkObservation(id, observation.mediaEventKey, [ref]);
    }
    media.deleteEvent(observation.mediaEventKey);
    db.prepare('DELETE FROM observations WHERE id=1').run();
    media.reconcile();
    expect(media.getMetadata(ref.id).state).toBe('ready');
    expect(existsSync(join(media.root, ref.id, 'viewer.webp'))).toBe(true);
    db.prepare('DELETE FROM observations WHERE id=2').run();
    media.reconcile();
    expect(() => media.getMetadata(ref.id)).toThrow('media_not_found');
    expect(existsSync(join(media.root, ref.id))).toBe(false);
  });

  it('a deleted event cannot be resurrected by a late replay', async () => {
    const observation = await ingest(anthropic());
    media.deleteEvent(observation.mediaEventKey);
    const replay = await ingest(anthropic());
    expect(replay.mediaRefs).toBeUndefined();
    expect(replay.mediaFailures[0]).toMatchObject({ code: 'media_not_found' });
  });
});

describe('real Read results: declared MIME is a hint, magic bytes are the authority', () => {
  it('a Read result with no declared type is captured by sniffing the bytes', async () => {
    const observation = await ingest(realReadImageResult(pngB64), { toolName: 'Read', toolInput: { file_path: '/p/shot.png' } });
    expect(observation.mediaFailures).toBeUndefined();
    expect(media.getMetadata(observation.mediaRefs[0].id).state).toBe('ready');
  });

  it('a Read result whose declared type disagrees with the bytes is converted as the sniffed format', async () => {
    const observation = await ingest(realReadImageResult(pngB64, 'image/jpeg'), { toolName: 'Read', toolInput: { file_path: '/p/shot.png' } });
    expect(observation.mediaFailures).toBeUndefined();
    expect(media.getMetadata(observation.mediaRefs[0].id).state).toBe('ready');
  });

  it('the captured Read descriptor keeps originalSize and dimensions beside the retained status', async () => {
    const observation = await ingest(realReadImageResult(pngB64, 'image/png'), { toolName: 'Read', toolInput: { file_path: '/p/shot.png' } });
    const file = JSON.parse(observation.tool_response).file;
    expect(file).toMatchObject({ type: 'image/png', originalSize: 4096, dimensions: { originalWidth: 320, originalHeight: 180 } });
    expect(file.base64).toBeUndefined();
    noBytes(observation.tool_response);
  });
});

describe('status substitution leaves untouched text alone', () => {
  const captureInput = (toolResponse: unknown) => ({
    enabled: true, sessionDbId: 1, contentSessionId: 'media-session', platformSource: 'claude',
    toolUseId: 'toolu_status', toolName: 'Bash', toolInput: { command: 'cat status.json' }, toolResponse, cwd: join(dir, 'project'),
  });

  it('a JSON-looking string that mentions media_status keeps its exact encoding when nothing was substituted', async () => {
    const original = '{ "media_status" : { "label" : "event1_image1" },\n  "note": "hand formatted" }';
    const result = await captureObservationMedia(captureInput(original), media);
    expect(result.toolResponse).toBe(original);
  });

  it('an object that mentions media_status keeps its identity when nothing was substituted', async () => {
    const original = { stdout: '{"media_status":{"label":"event1_image1"}}', nested: { media_status: { label: 'event1_image1' } } };
    const result = await captureObservationMedia(captureInput(original), media);
    expect(result.toolResponse).toBe(original);
  });
});

describe('scoped deletion triggers and indexed reference lookups', () => {
  const insertAttachment = (id: string, state = 'failed') => db.prepare(`INSERT INTO media_attachments(id,replay_key,provenance,recipe,state,created_at)
    VALUES(?,?,'{}','screenshot-v1',?,1)`).run(id, 'replay-' + id, state);

  it('reference lookups by attachment use an index rather than scanning media_event_refs', () => {
    const plan = JSON.stringify(db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM media_event_refs WHERE attachment_id=?').all('x'));
    // A covering-index SCAN is still a full scan; only SEARCH is a lookup.
    expect(plan).toContain('SEARCH media_event_refs USING');
    expect(plan).not.toContain('SCAN media_event_refs');
  });

  it('deleting an observation only reconsiders the attachments that observation linked', async () => {
    const unrelated = '33333333-3333-4333-8333-333333333333';
    insertAttachment(unrelated);
    const observation = await ingest(anthropic());
    const ref = observation.mediaRefs[0];
    db.prepare(`UPDATE sdk_sessions SET memory_session_id='m' WHERE content_session_id='media-session'`).run();
    db.prepare(`INSERT INTO observations(id,memory_session_id,project,type,title,created_at,created_at_epoch) VALUES(7,'m','p','discovery','t','2026-10-02T00:00:00Z',1)`).run();
    media.linkObservation(7, observation.mediaEventKey, [ref]);
    db.prepare(`DELETE FROM media_event_refs WHERE attachment_id=?`).run(ref.id);
    db.prepare('DELETE FROM observations WHERE id=7').run();
    expect(() => media.getMetadata(ref.id)).toThrow('media_not_found');
    expect((db.prepare('SELECT state FROM media_attachments WHERE id=?').get(unrelated) as any).state).toBe('failed');
    expect(db.prepare('SELECT 1 FROM media_cleanup_jobs WHERE attachment_id=?').get(unrelated)).toBeNull();
  });

  it('deleting a session only reconsiders the attachments its events referenced', async () => {
    const unrelated = '44444444-4444-4444-8444-444444444444';
    insertAttachment(unrelated);
    const ref = (await ingest(anthropic())).mediaRefs[0];
    const sessionDbId = (db.prepare('SELECT session_db_id FROM media_events').get() as any).session_db_id;
    db.prepare('DELETE FROM sdk_sessions WHERE id=?').run(sessionDbId);
    expect(() => media.getMetadata(ref.id)).toThrow('media_not_found');
    expect((db.prepare('SELECT state FROM media_attachments WHERE id=?').get(unrelated) as any).state).toBe('failed');
  });

  it('deleting an event only reconsiders the attachments that event referenced', async () => {
    const unrelated = '55555555-5555-4555-8555-555555555555';
    insertAttachment(unrelated);
    const observation = await ingest(anthropic());
    media.deleteEvent(observation.mediaEventKey);
    expect(() => media.getMetadata(observation.mediaRefs[0].id)).toThrow('media_not_found');
    expect((db.prepare('SELECT state FROM media_attachments WHERE id=?').get(unrelated) as any).state).toBe('failed');
  });

  it('an attachment still referenced by another session event survives a session delete', async () => {
    const ref = (await ingest(anthropic())).mediaRefs[0];
    db.prepare(`INSERT INTO sdk_sessions(id,content_session_id,memory_session_id,project,platform_source,started_at,started_at_epoch,status)
      VALUES(99,'other-content','other-memory','p','claude','2026-10-02T00:00:00Z',1,'completed')`).run();
    db.prepare(`INSERT INTO media_events(event_key,session_db_id,platform,event_identity,created_at) VALUES('other-event',99,'claude-code','{}',1)`).run();
    db.prepare(`INSERT INTO media_event_refs(event_key,attachment_id,label) VALUES('other-event',?,'event1_image1')`).run(ref.id);
    const sessionDbId = (db.prepare(`SELECT session_db_id FROM media_events WHERE event_key!='other-event'`).get() as any).session_db_id;
    db.prepare('DELETE FROM sdk_sessions WHERE id=?').run(sessionDbId);
    expect(media.getMetadata(ref.id).state).toBe('ready');
  });
});

describe('cleanup retries and hot-path reconciliation', () => {
  it('capture does not run reconciliation on the ingest path', async () => {
    const due = '66666666-6666-4666-8666-666666666666';
    db.prepare(`INSERT INTO media_attachments(id,replay_key,provenance,recipe,state,created_at) VALUES(?,'r','{}','screenshot-v1','deleted',1)`).run(due);
    db.prepare(`INSERT INTO media_cleanup_jobs(attachment_id,directory,queued_at) VALUES(?,?,0)`).run(due, due);
    await ingest(anthropic());
    expect(db.prepare('SELECT 1 FROM media_cleanup_jobs WHERE attachment_id=?').get(due)).not.toBeNull();
    media.reconcile();
    expect(db.prepare('SELECT 1 FROM media_cleanup_jobs WHERE attachment_id=?').get(due)).toBeNull();
  });

  it('a cleanup job that keeps failing stops at a bounded attempt count and logs only the code', async () => {
    const ref = (await ingest(anthropic())).mediaRefs[0];
    const sessionDbId = (db.prepare('SELECT session_db_id FROM media_events').get() as any).session_db_id;
    db.prepare('DELETE FROM sdk_sessions WHERE id=?').run(sessionDbId);
    const assetDir = join(media.root, ref.id);
    rmSync(assetDir, { recursive: true });
    mkdirSync(join(dir, 'elsewhere-retry'));
    symlinkSync(join(dir, 'elsewhere-retry'), assetDir, 'dir');
    const warn = spyOn(logger, 'warn');
    try {
      for (let attempt = 0; attempt < 40; attempt++) media.reconcile(Date.now() + attempt * 24 * 60 * 60 * 1000);
      const job = db.prepare('SELECT attempts,last_error,retry_at FROM media_cleanup_jobs').get() as any;
      expect(job.attempts).toBe(MEDIA_CLEANUP_MAX_ATTEMPTS);
      expect(job.last_error).toBe('retry_limit');
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('"code":"unsupported_source"');
      expect(logged).toContain('retry limit');
      expect(logged).not.toContain(dir);
    } finally { warn.mockRestore(); }
  });

  it('a conversion failure is logged with its bounded code only', async () => {
    const failing = new MediaStore(db, join(dir, 'data'), async () => { throw new Error(`decoder exploded reading ${dir}/secret.png`); });
    wire(sessions, failing);
    const warn = spyOn(logger, 'warn');
    try {
      const observation = await ingest(anthropic());
      expect(observation.mediaFailures[0]).toMatchObject({ code: 'storage_unavailable' });
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('storage_unavailable');
      expect(logged).not.toContain('secret.png');
      expect(logged).not.toContain(pngB64.slice(0, 64));
    } finally { warn.mockRestore(); }
  });

  it('the capture metric carries only IDs, sizes, recipe, shape, dimensions and timing (phase 6)', async () => {
    const info = spyOn(logger, 'info');
    try {
      const observation = await ingest(anthropic());
      const ref = observation.mediaRefs[0];
      const metric = info.mock.calls.find(call => call[1] === 'Media converted');
      expect(metric).toBeDefined();
      const fields = metric![2] as Record<string, unknown>;
      expect(Object.keys(fields).sort()).toEqual(['attachmentId', 'conversionMs', 'height', 'llmBytes', 'recipe', 'sourceBytes', 'sourceShape', 'viewerBytes', 'width']);
      expect(fields).toMatchObject({ attachmentId: ref.id, recipe: 'screenshot-v1', sourceShape: 'anthropic_base64', sourceBytes: png.byteLength, width: 320, height: 180 });
      for (const value of Object.values(fields)) expect(['string', 'number']).toContain(typeof value);
      const logged = JSON.stringify(metric);
      for (const forbidden of [dir, pngB64.slice(0, 64), ref.label, 'Took a screenshot', 'source_pointer', '.webp']) expect(logged).not.toContain(forbidden);
    } finally { info.mockRestore(); }
  });
});
