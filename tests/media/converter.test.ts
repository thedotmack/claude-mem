import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { convertMedia, createMediaConverter } from '../../src/services/media/converter.js';
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
  await assert.rejects(convertMedia(Buffer.alloc(MEDIA_LIMITS.maxSourceBytes + 1), 'image/png'), rejects('source_too_large'));
});

test('oversized dimensions and decoded pixel counts fail using the real decoder', async () => {
  await assert.rejects(convertMedia(await makePng(8193, 1), 'image/png'), rejects('dimension_limit'));
  await assert.rejects(convertMedia(await makePng(6000, 4001), 'image/png'), rejects('pixel_limit'));
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

test('application deadline includes queue/load time and holds admission until native work settles', async () => {
  let release!: (value: typeof sharp) => void;
  const loader = new Promise<typeof sharp>(resolve => { release = resolve; });
  const convert = createMediaConverter({ deadlineMs: 15, loadDecoder: () => loader });
  const png = await makePng();
  const first = convert(png, 'image/png');
  await assert.rejects(convert(png, 'image/png'), rejects('conversion_busy'));
  await assert.rejects(first, rejects('conversion_timeout'));
  await assert.rejects(convert(png, 'image/png'), rejects('conversion_busy'));
  release(sharp);
  await new Promise(resolve => setTimeout(resolve, 10));
  const next = createMediaConverter({ loadDecoder: async () => sharp });
  assert.equal((await next(png, 'image/png')).viewer.width, 80);
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

test('canonical byte ceiling rejects output without silently lowering fidelity', { timeout: 20_000 }, async () => {
  // Higher input quality reaches the canonical byte limit with fewer pixels.
  // Fixture preparation has its own test allowance; production remains 5s.
  await assert.rejects(convertMedia(await noisyJpeg(1200), 'image/jpeg'), rejects('canonical_too_large'));
});

test('derivative byte ceiling rejects output without silently lowering fidelity', { timeout: 20_000 }, async () => {
  await assert.rejects(convertMedia(await noisyJpeg(600), 'image/jpeg'), rejects('derivative_too_large'));
});

test('real decode and encode work is included in the application deadline', async () => {
  const source = await makePng(4000, 3000);
  const convert = createMediaConverter({ deadlineMs: 1, loadDecoder: async () => sharp });
  await assert.rejects(convert(source, 'image/png'), rejects('conversion_timeout'));
});

test('missing decoder is a safe media failure and larger deadlines cannot bypass policy', async () => {
  const missing = createMediaConverter({ loadDecoder: async () => { throw new MediaError('decoder_unavailable'); } });
  await assert.rejects(missing(await makePng(), 'image/png'), rejects('decoder_unavailable'));
  assert.throws(() => createMediaConverter({ deadlineMs: 6000 }), rejects('invalid_manifest'));
});
