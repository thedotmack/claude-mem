import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type sharp from 'sharp';
import { MEDIA_LIMITS, MEDIA_RECIPES, MediaError, type MediaRecipe } from '../../shared/media-contract.js';

type Decoder = typeof sharp;
export interface MediaVariant {
  bytes: Buffer;
  sha256: string;
  width: number;
  height: number;
  byteLength: number;
  mimeType: 'image/webp';
}
export interface ConvertedMedia {
  viewer: MediaVariant;
  llm: MediaVariant;
  source: { sha256: string; width: number; height: number; byteLength: number; mimeType: string };
  recipe: MediaRecipe;
  encoderVersion: string;
  conversionMs: number;
}

function sourceMime(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new MediaError('unsupported_format');
}

// libvips can expose the first frame of APNG as a still PNG. Reject its
// animation control chunk before decoding rather than silently retaining it.
function assertStillPng(bytes: Buffer): void {
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new MediaError('invalid_image');
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') throw new MediaError('animated_image');
    offset += length + 12;
  }
}

declare const __CMEM_MEDIA_STANDALONE__: boolean;
async function loadDecoder(): Promise<Decoder> {
  try {
    // A compiled worker resolves its native sidecar next to the executable,
    // independent of the current working directory or builder checkout.
    // https://bun.sh/docs/bundler#external
    if (typeof __CMEM_MEDIA_STANDALONE__ !== 'undefined' && __CMEM_MEDIA_STANDALONE__) {
      return createRequire(join(dirname(process.execPath), 'package.json'))('sharp') as Decoder;
    }
    return (await import('sharp')).default;
  }
  catch { throw new MediaError('decoder_unavailable'); }
}

/**
 * No-wait admission keeps the native queue bounded even when a caller times
 * out. Sharp's timeout excludes libuv queue waiting:
 * https://sharp.pixelplumbing.com/api-output/#timeout
 * A timed-out operation retains its slot until the underlying work settles.
 * The lower deadline/load seams let tests prove this without accepting larger
 * production limits or triggering a paid request.
 */
export function createMediaConverter(options: {
  deadlineMs?: number;
  loadDecoder?: () => Promise<Decoder>;
} = {}) {
  const deadlineMs = options.deadlineMs ?? MEDIA_LIMITS.conversionTimeoutSeconds * 1000;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > MEDIA_LIMITS.conversionTimeoutSeconds * 1000) {
    throw new MediaError('invalid_manifest');
  }
  let active = 0;
  return async function convertMedia(
    source: Uint8Array, claimedMime: string, recipe: MediaRecipe = 'screenshot-v1',
  ): Promise<ConvertedMedia> {
    if (source.byteLength === 0) throw new MediaError('invalid_image');
    if (source.byteLength > MEDIA_LIMITS.maxSourceBytes) throw new MediaError('source_too_large');
    if (!MEDIA_RECIPES.includes(recipe)) throw new MediaError('invalid_manifest');
    if (active >= MEDIA_LIMITS.maxConcurrentConversions) throw new MediaError('conversion_busy');
    active++;
    const started = performance.now();
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    const checkDeadline = () => {
      if (expired || performance.now() - started >= deadlineMs) throw new MediaError('conversion_timeout');
    };
    const work = (async (): Promise<ConvertedMedia> => {
      try {
        const bytes = Buffer.from(source);
        const mimeType = sourceMime(bytes);
        if (claimedMime !== mimeType) throw new MediaError('mime_mismatch');
        if (mimeType === 'image/png') assertStillPng(bytes);
        const decoder = await (options.loadDecoder ?? loadDecoder)();
        checkDeadline();
        // Copy the documented constructor limits and strict decoder failure
        // policy, never unlimited input or first-frame animated acceptance.
        // https://sharp.pixelplumbing.com/api-constructor/
        const inputOptions = {
          failOn: 'warning' as const,
          limitInputPixels: MEDIA_LIMITS.maxPixels,
          pages: 1,
          sequentialRead: true,
        };
        const metadata = await decoder(bytes, inputOptions)
          .timeout({ seconds: MEDIA_LIMITS.conversionTimeoutSeconds }).metadata();
        checkDeadline();
        if ((metadata.pages ?? 1) !== 1) throw new MediaError('animated_image');
        if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) throw new MediaError('unsupported_format');
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;
        if (!width || !height) throw new MediaError('invalid_image');
        if (width > MEDIA_LIMITS.maxDimension || height > MEDIA_LIMITS.maxDimension) throw new MediaError('dimension_limit');
        if (width * height > MEDIA_LIMITS.maxPixels) throw new MediaError('pixel_limit');
        const encode = async (derivative: boolean): Promise<MediaVariant> => {
          checkDeadline();
          // autoOrient applies EXIF orientation; default output omits all
          // input EXIF/ICC/XMP/IPTC/GPS. Do not call keepMetadata/withMetadata.
          // https://sharp.pixelplumbing.com/api-operation/#autoorient
          // https://sharp.pixelplumbing.com/api-output/#webp
          let pipeline = decoder(bytes, inputOptions).autoOrient();
          if (derivative) {
            // Full-frame fit, with no upscaling or semantic cropping.
            // https://sharp.pixelplumbing.com/api-resize/#resize
            pipeline = pipeline.resize({
              width: MEDIA_LIMITS.maxDerivativeDimension,
              height: MEDIA_LIMITS.maxDerivativeDimension,
              fit: 'inside', withoutEnlargement: true,
            });
          }
          const webpOptions = recipe === 'screenshot-v1'
            ? (derivative ? { nearLossless: true, quality: 90, effort: 4 } : { lossless: true, effort: 4 })
            : { quality: 90, effort: 4 };
          const { data, info } = await pipeline.webp(webpOptions)
            .timeout({ seconds: MEDIA_LIMITS.conversionTimeoutSeconds })
            .toBuffer({ resolveWithObject: true });
          checkDeadline();
          const maxBytes = derivative ? MEDIA_LIMITS.maxDerivativeBytes : MEDIA_LIMITS.maxCanonicalBytes;
          if (data.length > maxBytes) throw new MediaError(derivative ? 'derivative_too_large' : 'canonical_too_large');
          return { bytes: data, sha256: createHash('sha256').update(data).digest('hex'),
            width: info.width, height: info.height, byteLength: data.length, mimeType: 'image/webp' };
        };
        const viewer = await encode(false);
        const llm = await encode(true);
        return {
          viewer, llm, source: {
            sha256: createHash('sha256').update(bytes).digest('hex'),
            width, height, byteLength: bytes.length, mimeType,
          },
          recipe, encoderVersion: `sharp-${decoder.versions.sharp}/vips-${decoder.versions.vips}`,
          conversionMs: performance.now() - started,
        };
      } catch (error) {
        if (error instanceof MediaError) throw error;
        // Decoder errors can contain backend details. Keep stable safe codes.
        if (error instanceof Error && /pixel limit/i.test(error.message)) throw new MediaError('pixel_limit');
        if (error instanceof Error && /timeout|timed out/i.test(error.message)) throw new MediaError('conversion_timeout');
        throw new MediaError('invalid_image');
      }
    })().finally(() => { active--; });
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(new MediaError('conversion_timeout')); }, deadlineMs);
    });
    try { return await Promise.race([work, deadline]); }
    finally { clearTimeout(timer!); }
  };
}

// A lazy import occurs only when this function is called; text startup has no
// eager native dependency and capture/inference settings remain off by default.
export const convertMedia = createMediaConverter();
