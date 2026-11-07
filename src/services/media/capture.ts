import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MEDIA_LIMITS,
  MediaError,
  validateMediaEventIdentity,
  type MediaAttachmentRef,
  type MediaEventIdentity,
  type MediaFailureDescriptor,
  type MediaProvenance,
} from '../../shared/media-contract.js';
import { scanMediaFields, type MediaCandidate } from '../../shared/media-ingress.js';
import { logger } from '../../utils/logger.js';
import { stripMemoryTags } from '../../utils/tag-stripping.js';
import { readContainedFile } from './files.js';
import { MediaStore, mediaEventKey } from './store.js';
import { LOCAL_MAX_SOURCE_BYTES } from './converter.js';
import { createSourceByteBudget } from './source-budget.js';

interface CaptureInput {
  enabled: boolean;
  sessionDbId: number;
  contentSessionId: string;
  platformSource: string;
  toolUseId?: string;
  eventIdentity?: MediaEventIdentity;
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
  cwd: string;
}

export interface CaptureResult {
  toolInput: unknown;
  toolResponse: unknown;
  refs: MediaAttachmentRef[];
  failures: MediaFailureDescriptor[];
  eventKey?: string;
}

type MediaStatus = MediaFailureDescriptor | {
  version: 1;
  state: 'retained' | 'pending';
  inspection: 'uninspected';
  label: string;
  id: string;
};

const MAX_STATUS_SUBSTITUTION_DEPTH = 24;
const CANDIDATE_LABEL_PREFIX = 'event1_image';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CANONICAL_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function looksLikeJsonText(value: string): boolean {
  return value.startsWith('{') || value.startsWith('[') || value.startsWith('"');
}

/**
 * Replace the scanner's provisional `media_status` (by label) with the final
 * capture outcome. Anything without a substituted status keeps its identity,
 * and a JSON string keeps its exact original encoding.
 */
function substituteFinalStatuses(value: unknown, statusesByLabel: ReadonlyMap<string, MediaStatus>, depth = 0): unknown {
  if (statusesByLabel.size === 0 || depth > MAX_STATUS_SUBSTITUTION_DEPTH) return value;

  if (typeof value === 'string') {
    if (!looksLikeJsonText(value) || !value.includes('media_status')) return value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
    const substituted = substituteFinalStatuses(parsed, statusesByLabel, depth + 1);
    return substituted === parsed ? value : JSON.stringify(substituted);
  }

  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map(entry => {
      const next = substituteFinalStatuses(entry, statusesByLabel, depth + 1);
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? output : value;
  }

  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  let changed = false;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    let next = substituteFinalStatuses(entry, statusesByLabel, depth + 1);
    if (key === 'media_status') {
      const provisionalLabel = (entry as { label?: unknown } | null)?.label;
      if (typeof provisionalLabel === 'string' && statusesByLabel.has(provisionalLabel)) {
        next = statusesByLabel.get(provisionalLabel);
      }
    }
    if (next !== entry) changed = true;
    Object.defineProperty(output, key, { value: next, enumerable: true, writable: true, configurable: true });
  }
  return changed ? output : record;
}

/** Magic bytes decide the format; a declared MIME is only a hint. */
function sniffSupportedImageMimeType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new MediaError('unsupported_format');
}

function trustedFileTarget(candidate: MediaCandidate, input: CaptureInput): { projectRoot: string; targetPath: string } {
  const toolInput = input.toolInput as { file_path?: unknown } | null;
  if (input.toolName !== 'Read' || !toolInput || typeof toolInput.file_path !== 'string' || !input.cwd) {
    throw new MediaError('unsupported_source');
  }
  const projectRoot = realpathSync(input.cwd);
  const targetPath = resolve(projectRoot, candidate.filePath!);
  if (resolve(projectRoot, toolInput.file_path) !== targetPath) throw new MediaError('unsupported_source');
  return { projectRoot, targetPath };
}

function readTrustedFileCandidate(candidate: MediaCandidate, input: CaptureInput): Buffer {
  const { projectRoot, targetPath } = trustedFileTarget(candidate, input);
  return readContainedFile(projectRoot, targetPath, LOCAL_MAX_SOURCE_BYTES);
}

/**
 * File sources held by capture across the whole worker: at most one
 * maximum-size file source (LOCAL_MAX_SOURCE_BYTES, 96 MiB), however many
 * sessions capture at once. Abuse protection on worker memory: a capture that
 * waits for the conversion slot would otherwise keep its whole file buffer.
 */
export const fileSourceBudget = createSourceByteBudget(LOCAL_MAX_SOURCE_BYTES);

/**
 * The candidate's bytes and the budget release to call when its capture ends.
 * A file's size is reserved before the file is read, so a waiting capture
 * holds no image bytes. Inline bytes are already in the event in memory.
 */
async function reserveCandidateBytes(candidate: MediaCandidate, input: CaptureInput): Promise<{ bytes: Buffer; release: () => void }> {
  if (!candidate.filePath) return { bytes: decodeInlineCandidate(candidate), release: () => {} };
  const { projectRoot, targetPath } = trustedFileTarget(candidate, input);
  let size: number;
  try { size = statSync(targetPath).size; } catch { throw new MediaError('unsupported_source'); }
  if (!size || size > LOCAL_MAX_SOURCE_BYTES) throw new MediaError('source_too_large');
  const release = await fileSourceBudget.reserve(size);
  try {
    // A file that grew past its reserved size since the stat fails loudly.
    return { bytes: readContainedFile(projectRoot, targetPath, size), release };
  } catch (error) {
    release();
    throw error;
  }
}

function decodeInlineCandidate(candidate: MediaCandidate): Buffer {
  const encoded = candidate.encoded ?? '';
  if (!encoded || encoded.length % 4 !== 0 || !CANONICAL_BASE64_PATTERN.test(encoded)) throw new MediaError('invalid_image');
  if (encoded.length > MEDIA_LIMITS.maxInlineEncodedBytes) throw new MediaError('source_too_large');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MEDIA_LIMITS.maxSourceBytes) throw new MediaError('source_too_large');
  if (bytes.toString('base64') !== encoded) throw new MediaError('invalid_image');
  return bytes;
}

function candidateBytes(candidate: MediaCandidate, input: CaptureInput): Buffer {
  return candidate.filePath ? readTrustedFileCandidate(candidate, input) : decodeInlineCandidate(candidate);
}

function provenancePlatformOf(platformSource: string): MediaProvenance['platform'] | undefined {
  if (platformSource === 'claude') return 'claude-code';
  if (platformSource === 'codex') return 'codex';
  if (platformSource === 'cowork') return 'cowork';
  return undefined;
}

function resolveEventIdentity(input: CaptureInput, platform: MediaProvenance['platform'] | undefined): MediaEventIdentity | undefined {
  if (input.toolUseId && platform) {
    // Namespace the platform's tool-use ID by immutable session and platform
    // identity, so providers that reuse an ID in another session never collide.
    const namespacedId = createHash('sha256')
      .update(JSON.stringify([platform, input.contentSessionId, input.toolUseId]))
      .digest('hex');
    return { kind: 'platform_event', id: namespacedId };
  }
  if (!input.eventIdentity) return undefined;
  try {
    return validateMediaEventIdentity(input.eventIdentity);
  } catch {
    return undefined; // an unsupported native identity stays text-only
  }
}

/**
 * A replayed event must carry the same source it did the first time: the same
 * file locator (resolved against the physical project root, as at capture) and
 * the same bytes, so a file changed at the same path is never served stale.
 */
function assertReplayMatchesPriorSource(candidate: MediaCandidate, input: CaptureInput, priorProvenance: MediaProvenance): void {
  if (candidate.filePath) {
    const originalPath = priorProvenance.source_locator?.path;
    const toolInputFilePath = (input.toolInput as { file_path?: unknown } | null)?.file_path;
    if (input.toolName !== 'Read' || !input.cwd || toolInputFilePath !== candidate.filePath
      || originalPath !== resolve(realpathSync(input.cwd), candidate.filePath)) {
      throw new MediaError('unsupported_source');
    }
  }
  const replayedSourceSha256 = createHash('sha256').update(candidateBytes(candidate, input)).digest('hex');
  if (replayedSourceSha256 !== priorProvenance.source_sha256) throw new MediaError('checksum_mismatch');
}

/**
 * Labels of candidates that sit inside a memory-tag region (<private> and the
 * rest). The stored text is stripMemoryTags(JSON.stringify(...)) of each field,
 * and every candidate's descriptor carries its label, so a label that the strip
 * removes marks an image the user kept out of memory. Its pixels are never
 * read, stored, uploaded or sent to the observer.
 */
function labelsInsideMemoryTags(scanned: { toolInput: unknown; toolResponse: unknown }, candidates: readonly MediaCandidate[]): Set<string> {
  const hidden = new Set<string>();
  if (candidates.length === 0) return hidden;
  const fields = [scanned.toolInput, scanned.toolResponse]
    .filter(value => value !== undefined)
    .map(value => JSON.stringify(value));
  const strippedFields = fields.map(stripMemoryTags);
  for (const candidate of candidates) {
    const labelPattern = new RegExp(`${candidate.label}(?!\\d)`, 'g');
    const occurrences = (texts: string[]) => texts.reduce((total, text) => total + (text.match(labelPattern)?.length ?? 0), 0);
    if (occurrences(strippedFields) < occurrences(fields)) hidden.add(candidate.label);
  }
  return hidden;
}

export async function captureObservationMedia(
  input: CaptureInput,
  /**
   * The store, or a getter called only once an event holds an image. With
   * capture on by default, the getter keeps text-only events from touching
   * media storage at all; a getter that throws fails that image as
   * `storage_unavailable`, never the event.
   */
  store?: MediaStore | (() => MediaStore),
): Promise<CaptureResult> {
  let resolvedStore: MediaStore | undefined;
  const storeForCandidate = (): MediaStore | undefined =>
    resolvedStore ??= typeof store === 'function' ? store() : store;
  const scanned = scanMediaFields(input.toolInput, input.toolResponse, input.enabled ? 'capture' : 'disabled');
  const refs: MediaAttachmentRef[] = [];
  const failures: MediaFailureDescriptor[] = [...scanned.failures];
  const finalStatusesByLabel = new Map<string, MediaStatus>();
  const platform = provenancePlatformOf(input.platformSource);
  const identity = resolveEventIdentity(input, platform);
  let eventKey: string | undefined;
  const privateLabels = labelsInsideMemoryTags(scanned, scanned.candidates);

  for (const candidate of scanned.candidates) {
    if (privateLabels.has(candidate.label)) continue;
    let releaseSourceBytes = () => {};
    try {
      if (!platform || !identity || !store) throw new MediaError('unsupported_source');
      const mediaStore = storeForCandidate()!;
      const candidateEventKey = mediaEventKey(platform, identity);
      const prior = mediaStore.findEventSource(candidateEventKey, candidate.pointer);
      if (prior) {
        // Known event: keep its key even if replay validation below throws,
        // so ingest still finds its committed result and never re-queues it
        // (a second paid observer call).
        eventKey = candidateEventKey;
        assertReplayMatchesPriorSource(candidate, input, prior.provenance);
        if (prior.state === 'ready' || prior.state === 'converting') {
          refs.push(prior.ref);
          finalStatusesByLabel.set(candidate.label, {
            version: 1,
            state: prior.state === 'ready' ? 'retained' : 'pending',
            inspection: 'uninspected',
            label: prior.ref.label,
            id: prior.ref.id,
          });
          continue;
        }
      }

      const reserved = await reserveCandidateBytes(candidate, input);
      releaseSourceBytes = reserved.release;
      const sourceBytes = reserved.bytes;
      const provenance: Omit<MediaProvenance, 'attachment_id'> = {
        version: 1,
        platform,
        event_identity: identity,
        source_shape: candidate.shape,
        source_pointer: candidate.pointer,
        source_index: Number(candidate.label.slice(CANDIDATE_LABEL_PREFIX.length)) - 1,
        source_sha256: createHash('sha256').update(sourceBytes).digest('hex'),
        recipe: 'screenshot-v1',
        ...(candidate.filePath
          ? { source_locator: { kind: 'local_file' as const, path: resolve(realpathSync(input.cwd), candidate.filePath) } }
          : {}),
      };
      const ref = await mediaStore.capture({
        sessionDbId: input.sessionDbId,
        provenance,
        label: candidate.label,
        bytes: sourceBytes,
        mimeType: sniffSupportedImageMimeType(sourceBytes),
      });
      refs.push(ref);
      eventKey = candidateEventKey;
      finalStatusesByLabel.set(candidate.label, { version: 1, state: 'retained', inspection: 'uninspected', label: candidate.label, id: ref.id });
    } catch (error) {
      const code = error instanceof MediaError ? error.code : 'storage_unavailable';
      // Only the bounded code: decoder and storage errors can carry paths or bytes.
      logger.warn('INGEST', 'Media capture failed; observation keeps a text descriptor', { code, shape: candidate.shape });
      const failure: MediaFailureDescriptor = { version: 1, state: 'failed', code, inspection: 'uninspected', label: candidate.label };
      failures.push(failure);
      finalStatusesByLabel.set(candidate.label, failure);
    } finally {
      releaseSourceBytes();
    }
  }

  return {
    toolInput: substituteFinalStatuses(scanned.toolInput, finalStatusesByLabel),
    toolResponse: substituteFinalStatuses(scanned.toolResponse, finalStatusesByLabel),
    refs,
    failures,
    eventKey,
  };
}
