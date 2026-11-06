import { afterEach, beforeEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { MediaStore } from '../../src/services/media/store.js';
import { captureObservationMedia } from '../../src/services/media/capture.js';
import { MEDIA_LIMITS } from '../../src/shared/media-contract.js';

const SCRATCH = join(import.meta.dir, '../../.scratch');
let dir: string;
let db: Database;

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  dir = realpathSync(mkdtempSync(join(SCRATCH, 'media-large-')));
  mkdirSync(join(dir, 'project'));
  db = new Database(':memory:');
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

it('a Read of an image file over 3 MiB and over 8192 px is captured and fitted, not rejected', async () => {
  const sessions = new SessionStore(db);
  const sessionDbId = sessions.createSDKSession('large-source-session', 'project', '');
  const store = new MediaStore(db, join(dir, 'data'));
  // A tall noise PNG: about 3.5 MiB and 9000 px tall, over the old source and dimension bounds.
  const width = 136, height = 9000;
  const pixels = Buffer.alloc(width * height * 3);
  let state = 2463534242;
  for (let i = 0; i < pixels.length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; pixels[i] = state & 255; }
  const file = join(dir, 'project', 'full-page.png');
  writeFileSync(file, await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer());
  expect(Bun.file(file).size).toBeGreaterThan(MEDIA_LIMITS.maxSourceBytes);

  const result = await captureObservationMedia({
    enabled: true, sessionDbId, contentSessionId: 'large-source-session', platformSource: 'claude',
    toolUseId: 'toolu_large_read', toolName: 'Read', toolInput: { file_path: file },
    toolResponse: { type: 'image', file: { path: file } }, cwd: join(dir, 'project'),
  }, store);

  expect(result.failures).toEqual([]);
  expect(result.refs).toHaveLength(1);
  const metadata = store.getMetadata(result.refs[0]!.id);
  expect(metadata.state).toBe('ready');
  expect(Math.max(metadata.viewer!.width, metadata.viewer!.height)).toBeLessThanOrEqual(MEDIA_LIMITS.maxDimension);
  expect(metadata.viewer!.byteLength).toBeLessThanOrEqual(MEDIA_LIMITS.maxCanonicalBytes);
  expect(metadata.llm!.byteLength).toBeLessThanOrEqual(MEDIA_LIMITS.maxDerivativeBytes);
});
