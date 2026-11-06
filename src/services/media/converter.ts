import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type sharp from 'sharp';
import type { WebpOptions } from 'sharp';
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

/**
 * The screenshot-v1 derivative is retried once as lossy WebP quality 80 when
 * its near-lossless quality 90 encode is over MEDIA_LIMITS.maxDerivativeBytes
 * (docs/media-contract-v1.md, bounds and recipes). Quality 80 is measured, not
 * picked by feel: on 2026-11-05, 3 of 27 real screenshots had a near-lossless
 * derivative over 256 KiB, and all 27 fit as lossy quality 80 (largest 121 KiB).
 */
const SCREENSHOT_DERIVATIVE_RETRY_WEBP: WebpOptions = { quality: 80, effort: 4 };

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
 * Local worker capture bounds (docs/media-contract-v1.md, "Where the
 * conversion bounds apply"). This converter runs only in the local worker,
 * off the hook path: the PostToolUse hook writes a spool file and returns, and
 * the worker converts while it drains the spool. Pro's upload route keeps the
 * 5 s deadline and fail-at-once admission in MEDIA_LIMITS, which are about its
 * shared instances and its route's 59 s budget.
 *
 * Deadline, 20 s. Measured on 2026-11-05 with 27 real screenshots on a
 * 10-core Mac (the contract section has the runs): a conversion runs on about
 * one core (wall time matched CPU time at load 18 to 30), typical Retina
 * screenshots need 2.1 to 4.3 s, and the slowest accepted one (2880x6716)
 * needs 5.8 s, which already fails a 5 s deadline with spare cores. Under
 * load average 30 to 50, 11 of the 27 needed over 5 s and the slowest needed
 * 16.4 s. 20 s covers all 27 at that load.
 */
export const LOCAL_CONVERSION_DEADLINE_MS = 20_000;
/**
 * Admission wait, 20 s: one conversion runs at a time, and a second caller
 * waits its turn instead of failing at once. The callers that convert are the
 * hook-spool drain and the in-process transcript watcher; each converts one
 * image at a time, so a waiter normally waits behind at most one conversion,
 * which the deadline bounds at 20 s. A caller still waiting after that fails
 * `conversion_busy`, which is logged and kept on the observation's descriptor.
 */
export const LOCAL_ADMISSION_WAIT_MS = 20_000;

/**
 * One conversion at a time keeps native memory and CPU bounded; a caller
 * waits for the slot for at most admissionWaitMs (0 fails busy at once).
 * The application deadline starts once a caller holds the slot, before the
 * decoder loads. Sharp's timeout excludes libuv queue waiting:
 * https://sharp.pixelplumbing.com/api-output/#timeout
 * so each native step gets only the deadline time still left, rounded up to
 * whole seconds (sharp's unit). A timed-out conversion keeps the slot until
 * its native step settles, which is then at most about a second later.
 * The lower deadline/wait/load seams let tests prove this without accepting
 * larger limits or triggering a paid request.
 */
export function createMediaConverter(options: {
  deadlineMs?: number;
  admissionWaitMs?: number;
  loadDecoder?: () => Promise<Decoder>;
} = {}) {
  const deadlineMs = options.deadlineMs ?? LOCAL_CONVERSION_DEADLINE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > LOCAL_CONVERSION_DEADLINE_MS) {
    throw new MediaError('invalid_manifest');
  }
  const admissionWaitMs = options.admissionWaitMs ?? LOCAL_ADMISSION_WAIT_MS;
  if (!Number.isFinite(admissionWaitMs) || admissionWaitMs < 0 || admissionWaitMs > LOCAL_ADMISSION_WAIT_MS) {
    throw new MediaError('invalid_manifest');
  }
  let active = 0;
  const waiting: Array<() => void> = [];
  const admit = async (): Promise<void> => {
    if (active < MEDIA_LIMITS.maxConcurrentConversions) { active++; return; }
    if (admissionWaitMs === 0) throw new MediaError('conversion_busy');
    await new Promise<void>((resolve, reject) => {
      const turn = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(turn), 1);
        reject(new MediaError('conversion_busy'));
      }, admissionWaitMs);
      waiting.push(turn);
    });
  };
  // First come, first served: the slot passes straight to the oldest waiter.
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else active--;
  };
  return async function convertMedia(
    source: Uint8Array, claimedMime: string, recipe: MediaRecipe = 'screenshot-v1',
  ): Promise<ConvertedMedia> {
    if (source.byteLength === 0) throw new MediaError('invalid_image');
    if (source.byteLength > MEDIA_LIMITS.maxSourceBytes) throw new MediaError('source_too_large');
    if (!MEDIA_RECIPES.includes(recipe)) throw new MediaError('invalid_manifest');
    await admit();
    const started = performance.now();
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    const checkDeadline = () => {
      if (expired || performance.now() - started >= deadlineMs) throw new MediaError('conversion_timeout');
    };
    const nativeTimeout = () => ({ seconds: Math.max(1, Math.ceil((deadlineMs - (performance.now() - started)) / 1000)) });
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
          .timeout(nativeTimeout()).metadata();
        checkDeadline();
        if ((metadata.pages ?? 1) !== 1) throw new MediaError('animated_image');
        if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) throw new MediaError('unsupported_format');
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;
        if (!width || !height) throw new MediaError('invalid_image');
        if (width > MEDIA_LIMITS.maxDimension || height > MEDIA_LIMITS.maxDimension) throw new MediaError('dimension_limit');
        if (width * height > MEDIA_LIMITS.maxPixels) throw new MediaError('pixel_limit');
        const encode = async (derivative: boolean, webpOptions: WebpOptions): Promise<MediaVariant> => {
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
          const { data, info } = await pipeline.webp(webpOptions)
            .timeout(nativeTimeout())
            .toBuffer({ resolveWithObject: true });
          checkDeadline();
          return { bytes: data, sha256: createHash('sha256').update(data).digest('hex'),
            width: info.width, height: info.height, byteLength: data.length, mimeType: 'image/webp' };
        };
        const screenshot = recipe === 'screenshot-v1';
        const viewer = await encode(false, screenshot ? { lossless: true, effort: 4 } : { quality: 90, effort: 4 });
        if (viewer.byteLength > MEDIA_LIMITS.maxCanonicalBytes) throw new MediaError('canonical_too_large');
        let llm = await encode(true, screenshot ? { nearLossless: true, quality: 90, effort: 4 } : { quality: 90, effort: 4 });
        // One retry, never a loop; the deadline above still covers it.
        if (screenshot && llm.byteLength > MEDIA_LIMITS.maxDerivativeBytes) {
          llm = await encode(true, SCREENSHOT_DERIVATIVE_RETRY_WEBP);
        }
        if (llm.byteLength > MEDIA_LIMITS.maxDerivativeBytes) throw new MediaError('derivative_too_large');
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
    })().finally(release);
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
