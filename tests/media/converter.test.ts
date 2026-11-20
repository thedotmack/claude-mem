import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { convertMedia, createMediaConverter, LOCAL_ADMISSION_WAIT_MS, LOCAL_CONVERSION_DEADLINE_MS, LOCAL_MAX_INPUT_PIXELS, LOCAL_MAX_SOURCE_BYTES } from '../../src/services/media/converter.js';
import { MEDIA_LIMITS, MediaError } from '../../src/shared/media-contract.js';

const rejects = (code: string) => (error: unknown) => error instanceof MediaError && error.code === code;
const makePng = (width = 80, height = 40) => sharp({
  create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
}).png().toBuffer();

test('both variants are real bounded WebP, preserve alpha and never return source bytes', async () => {
  const source = await makePng(1700, 900);
  const result = await convertMedia(source, 'image/png');
  assert.equal(result.recipe, 'screenshot-v1');
  assert.match(result.encoderVersion, /^sharp-[\d.]+\/vips-[\d.]+$/);
  assert.equal(result.source.width, 1700);
  for (const variant of [result.viewer, result.llm]) {
    const metadata = await sharp(variant.bytes).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.hasAlpha, true);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.icc, undefined);
    assert.equal(metadata.xmp, undefined);
    assert.equal(variant.byteLength, variant.bytes.length);
    assert.equal(variant.sha256.length, 64);
    assert.equal(metadata.width, variant.width);
    assert.equal(metadata.height, variant.height);
    assert.notDeepEqual(variant.bytes, source);
  }
  assert.equal(result.viewer.width, 1700);
  assert.equal(result.viewer.height, 900);
  assert.equal(Math.max(result.llm.width, result.llm.height), 1536);
  assert.ok(result.llm.byteLength <= MEDIA_LIMITS.maxDerivativeBytes);
  const pixel = await sharp(result.viewer.bytes).raw().toBuffer();
  assert.ok(pixel[3]! >= 126 && pixel[3]! <= 129);
});

test('JPEG orientation is applied and private EXIF/GPS metadata is removed', async () => {
  // Metadata writes only create a synthetic adversarial input fixture.
  const source = await sharp({ create: { width: 80, height: 40, channels: 3, background: 'blue' } })
    .jpeg().withMetadata({ orientation: 6 }).withExif({
      IFD0: { ImageDescription: 'private-fixture-caption' },
      IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'W' },
    }).toBuffer();
  const inputMetadata = await sharp(source).metadata();
  assert.ok(inputMetadata.exif);
  assert.equal(inputMetadata.orientation, 6);
  const result = await convertMedia(source, 'image/jpeg', 'photo-v1');
  assert.equal(result.viewer.width, 40);
  assert.equal(result.viewer.height, 80);
  for (const variant of [result.viewer, result.llm]) {
    const metadata = await sharp(variant.bytes).metadata();
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.icc, undefined);
    assert.equal(metadata.orientation, undefined);
  }
});

test('WebP input, no enlargement, MIME spoof, empty, truncated and unsupported inputs', async () => {
  const png = await makePng();
  const webp = await sharp(png).webp().toBuffer();
  const result = await convertMedia(webp, 'image/webp');
  assert.equal(result.llm.width, 80);
  await assert.rejects(convertMedia(png, 'image/jpeg'), rejects('mime_mismatch'));
  await assert.rejects(convertMedia(Buffer.alloc(0), 'image/png'), rejects('invalid_image'));
  await assert.rejects(convertMedia(png.subarray(0, 45), 'image/png'), rejects('invalid_image'));
  await assert.rejects(convertMedia(Buffer.from('<svg/>'), 'image/svg+xml'), rejects('unsupported_format'));
  await assert.rejects(convertMedia(Buffer.alloc(LOCAL_MAX_SOURCE_BYTES + 1), 'image/png'), rejects('source_too_large'));
});

test('a source over the canonical dimension or pixel bound is fitted into it, not rejected', { timeout: 20_000 }, async () => {
  const tall = await convertMedia(await makePng(200, 9000), 'image/png');
  assert.equal(tall.source.height, 9000);
  assert.equal(Math.max(tall.viewer.width, tall.viewer.height), MEDIA_LIMITS.maxDimension);
  const wide = await convertMedia(await makePng(6000, 4001), 'image/png');
  assert.ok(wide.viewer.width * wide.viewer.height <= MEDIA_LIMITS.maxPixels);
  assert.ok(wide.viewer.width * wide.viewer.height > MEDIA_LIMITS.maxPixels * 0.99, 'fitted, not shrunk further');
  for (const result of [tall, wide]) assert.ok(Math.max(result.llm.width, result.llm.height) <= MEDIA_LIMITS.maxDerivativeDimension);
});

test('the decoder still refuses input over sharp\'s own default pixel limit', async () => {
  assert.equal(LOCAL_MAX_INPUT_PIXELS, 16383 * 16383);
  // A 16384x16384 PNG header over a tiny body: a decompression bomb.
  const bomb = Buffer.from('89504e470d0a1a0a0000000d494844520000400000004000080200000026aa87d30000000849444154789c030000000001480689d20000000049454e44ae426082', 'hex');
  await assert.rejects(convertMedia(bomb, 'image/png'), rejects('pixel_limit'));
});

test('animated WebP and APNG controls are rejected instead of extracting frame one', async () => {
  const frames = Buffer.from([
    255,0,0,255, 255,0,0,255, 255,0,0,255, 255,0,0,255,
    0,0,255,255, 0,0,255,255, 0,0,255,255, 0,0,255,255,
  ]);
  const animated = await sharp(frames, { raw: { width: 2, height: 4, channels: 4, pageHeight: 2 } })
    .webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
  await assert.rejects(convertMedia(animated, 'image/webp'), rejects('animated_image'));
  const png = await makePng();
  const control = Buffer.alloc(20);
  control.writeUInt32BE(8, 0); control.write('acTL', 4); control.writeUInt32BE(2, 8);
  const apng = Buffer.concat([png.subarray(0, 33), control, png.subarray(33)]);
  await assert.rejects(convertMedia(apng, 'image/png'), rejects('animated_image'));
});

test('with no admission wait, a second caller fails busy and the slot is held until native work settles', async () => {
  let release!: (value: typeof sharp) => void;
  const loader = new Promise<typeof sharp>(resolve => { release = resolve; });
  const convert = createMediaConverter({ deadlineMs: 15, admissionWaitMs: 0, loadDecoder: () => loader });
  const png = await makePng();
  const first = convert(png, 'image/png');
  await assert.rejects(convert(png, 'image/png'), rejects('conversion_busy'));
  await assert.rejects(first, rejects('conversion_timeout'));
  await assert.rejects(convert(png, 'image/png'), rejects('conversion_busy'));
  release(sharp);
  // The converter that timed out admits work again once its native work
  // settles; the wait is bounded so a converter stuck busy fails the test.
  let recovered: unknown = 'conversion_busy';
  for (let wait = 0; wait < 100 && recovered === 'conversion_busy'; wait++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    recovered = await convert(png, 'image/png').then(result => result.viewer.width, (error: MediaError) => error.code);
  }
  assert.notEqual(recovered, 'conversion_busy');
  const next = createMediaConverter({ loadDecoder: async () => sharp });
  assert.equal((await next(png, 'image/png')).viewer.width, 80);
});

test('local bounds: 20 s deadline and 20 s admission wait are the most a converter accepts', () => {
  assert.equal(LOCAL_CONVERSION_DEADLINE_MS, 20_000);
  assert.equal(LOCAL_ADMISSION_WAIT_MS, 20_000);
  assert.throws(() => createMediaConverter({ deadlineMs: LOCAL_CONVERSION_DEADLINE_MS + 1 }), rejects('invalid_manifest'));
  assert.throws(() => createMediaConverter({ admissionWaitMs: LOCAL_ADMISSION_WAIT_MS + 1 }), rejects('invalid_manifest'));
  assert.throws(() => createMediaConverter({ admissionWaitMs: -1 }), rejects('invalid_manifest'));
});

test('a second caller waits for the slot, first come first served, and both convert', async () => {
  let release!: (value: typeof sharp) => void;
  const loader = new Promise<typeof sharp>(resolve => { release = resolve; });
  const convert = createMediaConverter({ admissionWaitMs: 5_000, loadDecoder: () => loader });
  const finished: string[] = [];
  const first = convert(await makePng(80, 40), 'image/png').then(result => { finished.push('first'); return result; });
  const second = convert(await makePng(60, 30), 'image/png').then(result => { finished.push('second'); return result; });
  const third = convert(await makePng(40, 20), 'image/png').then(result => { finished.push('third'); return result; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(finished, []);
  release(sharp);
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(results.map(result => result.viewer.width), [80, 60, 40]);
  assert.deepEqual(finished, ['first', 'second', 'third']);
});

test('a caller that waits longer than the admission wait fails busy, and the queue keeps working', async () => {
  let release!: (value: typeof sharp) => void;
  const loader = new Promise<typeof sharp>(resolve => { release = resolve; });
  const convert = createMediaConverter({ admissionWaitMs: 30, loadDecoder: () => loader });
  const png = await makePng();
  const first = convert(png, 'image/png');
  await assert.rejects(convert(png, 'image/png'), rejects('conversion_busy'));
  release(sharp);
  assert.equal((await first).viewer.width, 80);
  // The waiter that gave up left the queue; the slot was not handed to it.
  assert.equal((await convert(png, 'image/png')).viewer.width, 80);
});

test('after a conversion times out, the next caller waits for its native work instead of failing busy', async () => {
  let release!: (value: typeof sharp) => void;
  const held = new Promise<typeof sharp>(resolve => { release = resolve; });
  let loads = 0;
  const convert = createMediaConverter({
    deadlineMs: 200, admissionWaitMs: 5_000,
    loadDecoder: () => (++loads === 1 ? held : Promise.resolve(sharp)),
  });
  const png = await makePng();
  const first = convert(png, 'image/png');
  const next = convert(png, 'image/png');
  await assert.rejects(first, rejects('conversion_timeout'));
  // The timed-out work still holds the slot; the waiter gets it once that
  // work settles, and its own deadline starts only then.
  setTimeout(() => release(sharp), 100);
  assert.equal((await next).viewer.width, 80);
  assert.equal(loads, 2);
});

test('each native step gets only the deadline time still left, in whole seconds', { timeout: 20_000 }, async () => {
  const seconds: number[] = [];
  const recordingDecoder = Object.assign((input: Buffer, inputOptions: sharp.SharpOptions) => {
    const instance = sharp(input, inputOptions);
    const timeout = instance.timeout.bind(instance);
    instance.timeout = (options: { seconds: number }) => { seconds.push(options.seconds); return timeout(options); };
    return instance;
  }, sharp) as unknown as typeof sharp;
  // The decoder takes 1.2 s to load, so 1.8 s of a 3 s deadline is left.
  const convert = createMediaConverter({
    deadlineMs: 3_000,
    loadDecoder: () => new Promise(resolve => setTimeout(() => resolve(recordingDecoder), 1_200)),
  });
  await convert(await makePng(), 'image/png');
  assert.ok(seconds.length >= 3, 'metadata and both encodes set a native timeout');
  assert.deepEqual(seconds, seconds.map(() => 2));
  // With no time used yet, a step gets the whole deadline.
  seconds.length = 0;
  await createMediaConverter({ loadDecoder: async () => recordingDecoder })(await makePng(), 'image/png');
  assert.equal(seconds[0], LOCAL_CONVERSION_DEADLINE_MS / 1000);
});

async function noisyJpeg(dimension: number): Promise<Buffer> {
  const pixels = Buffer.alloc(dimension * dimension * 3);
  let state = 123456789;
  for (let i = 0; i < pixels.length; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    pixels[i] = state & 255;
  }
  return sharp(pixels, { raw: { width: dimension, height: dimension, channels: 3 } })
    .jpeg({ quality: 90 }).toBuffer();
}

// A lossless WebP has a VP8L bitstream chunk; a lossy one has "VP8 ".
const isLossyWebp = (bytes: Buffer) => bytes.includes('VP8 ') && !bytes.includes('VP8L');

const derivativeBytes = async (source: Buffer, webp: sharp.WebpOptions) => sharp(source).autoOrient()
  .resize({ width: MEDIA_LIMITS.maxDerivativeDimension, height: MEDIA_LIMITS.maxDerivativeDimension, fit: 'inside', withoutEnlargement: true })
  .webp(webp).toBuffer();

test('every copy of both recipes is lossy WebP: quality 80 for screenshot-v1, 90 for photo-v1', async () => {
  const source = await makePng(1700, 900);
  const screenshot = await convertMedia(source, 'image/png');
  assert.deepEqual(screenshot.viewer.bytes, await sharp(source).autoOrient().webp({ quality: 80, effort: 4 }).toBuffer());
  assert.deepEqual(screenshot.llm.bytes, await derivativeBytes(source, { quality: 80, effort: 4 }));
  const photo = await convertMedia(source, 'image/png', 'photo-v1');
  assert.deepEqual(photo.viewer.bytes, await sharp(source).autoOrient().webp({ quality: 90, effort: 4 }).toBuffer());
  assert.deepEqual(photo.llm.bytes, await derivativeBytes(source, { quality: 90, effort: 4 }));
  for (const variant of [screenshot.viewer, screenshot.llm, photo.viewer, photo.llm]) {
    assert.ok(isLossyWebp(variant.bytes), 'no lossless or near-lossless copy is stored');
  }
});

test('a screenshot canonical over 1 MiB at quality 80 is shrunk at quality 80 until it fits', { timeout: 30_000 }, async () => {
  assert.equal(MEDIA_LIMITS.maxEncodedCanonicalBytes, 1024 * 1024);
  const source = await noisyJpeg(1600);
  assert.ok((await sharp(source).webp({ quality: 80, effort: 4 }).toBuffer()).length > MEDIA_LIMITS.maxEncodedCanonicalBytes,
    'fixture must be over the encoded canonical ceiling at quality 80');
  const result = await convertMedia(source, 'image/jpeg');
  assert.ok(result.viewer.byteLength <= MEDIA_LIMITS.maxEncodedCanonicalBytes);
  assert.ok(result.viewer.width < 1600 && result.viewer.width === result.viewer.height);
  assert.deepEqual(result.viewer.bytes, await sharp(source).autoOrient()
    .resize({ width: result.viewer.width, height: result.viewer.width, fit: 'inside' }).webp({ quality: 80, effort: 4 }).toBuffer());
  assert.ok(isLossyWebp(result.viewer.bytes));
  assert.ok(result.llm.byteLength <= MEDIA_LIMITS.maxDerivativeBytes);
});

test('a screenshot derivative over the ceiling at quality 80 is shrunk at quality 80 until it fits', { timeout: 20_000 }, async () => {
  const source = await noisyJpeg(800);
  assert.ok((await derivativeBytes(source, { quality: 80, effort: 4 })).length > MEDIA_LIMITS.maxDerivativeBytes,
    'fixture must be over the derivative ceiling at quality 80');
  const result = await convertMedia(source, 'image/jpeg');
  assert.ok(result.llm.byteLength <= MEDIA_LIMITS.maxDerivativeBytes);
  assert.ok(result.llm.width < 800);
  assert.deepEqual(result.llm.bytes, await sharp(source).autoOrient()
    .resize({ width: result.llm.width, height: result.llm.width, fit: 'inside' }).webp({ quality: 80, effort: 4 }).toBuffer());
});

test('a photo derivative over the ceiling is shrunk at quality 90', { timeout: 20_000 }, async () => {
  const source = await noisyJpeg(600);
  assert.ok((await derivativeBytes(source, { quality: 90, effort: 4 })).length > MEDIA_LIMITS.maxDerivativeBytes);
  const result = await convertMedia(source, 'image/jpeg', 'photo-v1');
  assert.ok(result.llm.byteLength <= MEDIA_LIMITS.maxDerivativeBytes);
  assert.deepEqual(result.llm.bytes, await sharp(source).autoOrient()
    .resize({ width: result.llm.width, height: result.llm.width, fit: 'inside' }).webp({ quality: 90, effort: 4 }).toBuffer());
});

test('the application deadline covers a shrink round', { timeout: 20_000 }, async () => {
  const source = await noisyJpeg(800);
  const initialEncode = await sharp(source).autoOrient().webp({ quality: 80, effort: 4 }).toBuffer({ resolveWithObject: true });
  // Reuse the initial encode so only the stalled shrink consumes the deadline.
  // Wrap the real decoder so a shrink encode (resized below the 800 px
  // source) never settles until released; only the deadline can end it.
  let shrinkStarted = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const slowShrinkDecoder = Object.assign((input: Buffer, inputOptions: sharp.SharpOptions) => {
    const instance = sharp(input, inputOptions);
    const resize = instance.resize.bind(instance) as (options: sharp.ResizeOptions) => sharp.Sharp;
    const toBuffer = instance.toBuffer.bind(instance) as (options: { resolveWithObject: true }) => Promise<unknown>;
    (instance as unknown as { toBuffer: unknown }).toBuffer = async () => initialEncode;
    (instance as unknown as { resize: unknown }).resize = (options: sharp.ResizeOptions) => {
      if ((options.width ?? Infinity) < 800) {
        shrinkStarted = true;
        (instance as unknown as { toBuffer: unknown }).toBuffer = async (options: { resolveWithObject: true }) => {
          await held;
          return toBuffer(options);
        };
      }
      return resize(options);
    };
    return instance;
  }, sharp) as unknown as typeof sharp;
  const convert = createMediaConverter({ deadlineMs: 1500, loadDecoder: async () => slowShrinkDecoder });
  try {
    await assert.rejects(convert(source, 'image/jpeg'), rejects('conversion_timeout'));
    assert.equal(shrinkStarted, true, 'the timeout must come from the shrink encode');
  } finally { release(); }
});

test('real decode and encode work is included in the application deadline', async () => {
  const source = await makePng(4000, 3000);
  const convert = createMediaConverter({ deadlineMs: 1, loadDecoder: async () => sharp });
  await assert.rejects(convert(source, 'image/png'), rejects('conversion_timeout'));
});

test('missing decoder is a safe media failure and larger deadlines cannot bypass policy', async () => {
  const missing = createMediaConverter({ loadDecoder: async () => { throw new MediaError('decoder_unavailable'); } });
  await assert.rejects(missing(await makePng(), 'image/png'), rejects('decoder_unavailable'));
  assert.throws(() => createMediaConverter({ deadlineMs: LOCAL_CONVERSION_DEADLINE_MS + 1000 }), rejects('invalid_manifest'));
});

test("sharp's wasm32 build is refused before any decode (#5601)", async () => {
  // Bun's auto-install resolved sharp to @img/sharp-wasm32 in a plugin root
  // without node_modules; its first metadata() blocked the main thread forever,
  // so the deadline timer below never fired. The wasm build must never decode.
  let decodeCalls = 0;
  const wasmDecoder = Object.assign(() => { decodeCalls++; return sharp(Buffer.alloc(0)); }, sharp, {
    versions: { ...sharp.versions, emscripten: '6.0.10' },
  }) as unknown as typeof sharp;
  const convert = createMediaConverter({ loadDecoder: async () => wasmDecoder });
  await assert.rejects(convert(await makePng(), 'image/png'), rejects('decoder_unavailable'));
  assert.equal(decodeCalls, 0);
  // The native build that ships in plugin/node_modules still decodes.
  assert.equal('emscripten' in sharp.versions, false);
  const native = await createMediaConverter({ loadDecoder: async () => sharp })(await makePng(), 'image/png');
  assert.equal(native.source.width, 80);
});

test('the owner quota stays at the value Pro enforces', () => {
  // Pro's src/lib/media/contract.ts and drizzle/0107 enforce 25 GiB (uploads past
  // it answer 413 quota_exceeded; claude-mem-pro#396). The shared contract must not
  // promise more until Pro changes first.
  assert.equal(MEDIA_LIMITS.ownerQuotaBytes, 25 * 1024 * 1024 * 1024);
});
