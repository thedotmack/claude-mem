import {
  MEDIA_LIMITS,
  MEDIA_SOURCE_MIMES,
  type MediaErrorCode,
  type MediaFailureDescriptor,
  type MediaSourceShape,
} from './media-contract.js';
import {
  anthropicImageSourceOf,
  claudeReadImageFileOf,
  declaredReadImageMimeType,
  isMcpInlineImageBlock,
  isPlainRecord,
  openAiImageUrlOf,
  type UnknownRecord,
} from './native-image-shapes.js';

export interface MediaCandidate {
  pointer: string;
  label: string;
  shape: MediaSourceShape;
  /** Declared by the tool; a hint only. The worker's magic-byte check is the authority. */
  mimeType?: string;
  encoded?: string;
  filePath?: string;
}

/**
 * - `dispatch`: hook side, before HTTP. Accepted bytes stay so the worker can convert them.
 * - `capture`: worker side. Accepted bytes become candidates and leave the text.
 * - `disabled`: capture flag off. Every image leaves the text with a disabled status.
 * - `reject`: dispatch fallback for an oversized event. Every image leaves the text.
 */
export type MediaScanStage = 'dispatch' | 'capture' | 'disabled' | 'reject';

export interface MediaScanResult {
  toolInput: unknown;
  toolResponse: unknown;
  candidates: MediaCandidate[];
  failures: MediaFailureDescriptor[];
  /**
   * The walk stopped descending somewhere. Values past the bound are returned
   * unchanged (never rewritten), the same passthrough as the observer prompt
   * stripper past its depth bound (sdk/prompts.ts stripImagePayloads).
   */
  walkLimitReached: boolean;
}

const SUPPORTED_SOURCE_MIME_TYPES: ReadonlySet<string> = new Set(MEDIA_SOURCE_MIMES);
const DATA_IMAGE_URL_PATTERN = /^data:(image\/[^;,]+);base64,(.*)$/is;
/** A JSON string is only worth parsing when it names an image (same marker as sdk/prompts.ts). */
const IMAGE_MARKER_IN_JSON_TEXT = /image(?:"|\\|_url)|data:image\//i;
const ELIDED_IMAGE_NOTE = 'image data withheld from the observer';
const MAX_WALKED_NODES = 4096;
const MAX_WALK_DEPTH = 20;

interface RecognizedImageBlock {
  shape: MediaSourceShape;
  /** Key of the object holding the bytes, or null when they sit on the block itself (MCP). */
  byteContainerKey: 'source' | 'file' | 'image_url' | null;
  /** Key of the byte field inside that container; absent for a typed file locator. */
  byteFieldKey?: 'data' | 'base64' | 'url';
  encodedBytes?: string;
  declaredMimeType?: string;
  trustedFilePath?: string;
}

/**
 * Recognized native image shapes only: no path heuristics, no remote fetch,
 * no interpretation of prompt attachments. Shape predicates are shared with
 * sdk/prompts.ts so the capture scanner and the prompt stripper agree.
 */
function recognizeImageBlock(block: UnknownRecord): RecognizedImageBlock | undefined {
  const anthropicSource = anthropicImageSourceOf(block);
  if (anthropicSource && typeof anthropicSource.data === 'string') {
    return {
      shape: 'anthropic_base64',
      byteContainerKey: 'source',
      byteFieldKey: 'data',
      encodedBytes: anthropicSource.data,
      declaredMimeType: typeof anthropicSource.media_type === 'string' ? anthropicSource.media_type : undefined,
    };
  }

  const readImageFile = claudeReadImageFileOf(block);
  if (readImageFile && typeof readImageFile.base64 === 'string') {
    return {
      shape: 'claude_read_base64',
      byteContainerKey: 'file',
      byteFieldKey: 'base64',
      encodedBytes: readImageFile.base64,
      declaredMimeType: declaredReadImageMimeType(readImageFile),
    };
  }

  if (isMcpInlineImageBlock(block)) {
    return {
      shape: 'mcp_base64',
      byteContainerKey: null,
      byteFieldKey: 'data',
      encodedBytes: block.data as string,
      declaredMimeType: typeof block.mimeType === 'string' ? block.mimeType : undefined,
    };
  }

  const openAiImageUrl = openAiImageUrlOf(block);
  if (openAiImageUrl && typeof openAiImageUrl.url === 'string') {
    const dataUrlMatch = DATA_IMAGE_URL_PATTERN.exec(openAiImageUrl.url);
    if (dataUrlMatch) {
      return {
        shape: 'openai_data_url',
        byteContainerKey: 'image_url',
        byteFieldKey: 'url',
        encodedBytes: dataUrlMatch[2],
        declaredMimeType: dataUrlMatch[1].toLowerCase(),
      };
    }
  }

  // Only the worker can authorize this explicit typed Read locator.
  if (readImageFile && typeof readImageFile.path === 'string') {
    return {
      shape: 'trusted_tool_file',
      byteContainerKey: 'file',
      trustedFilePath: readImageFile.path,
      declaredMimeType: declaredReadImageMimeType(readImageFile),
    };
  }

  return undefined;
}

function escapeJsonPointerToken(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function withoutKey(record: UnknownRecord, removedKey: string | undefined): UnknownRecord {
  const output: UnknownRecord = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === removedKey) continue;
    Object.defineProperty(output, key, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  return output;
}

function looksLikeJsonText(value: string): boolean {
  return value.startsWith('{') || value.startsWith('[') || value.startsWith('"');
}

/**
 * Walk a tool payload, turning recognized image bodies into capture
 * candidates and bounded text descriptors. Anything that holds no image keeps
 * its identity (and a JSON string keeps its exact encoding).
 */
export function scanMediaFields(toolInput: unknown, toolResponse: unknown, stage: MediaScanStage = 'capture'): MediaScanResult {
  const candidates: MediaCandidate[] = [];
  const failures: MediaFailureDescriptor[] = [];
  let walkedNodeCount = 0;
  let walkLimitReached = false;
  let recognizedImageCount = 0;
  let acceptedEncodedCharacters = 0;

  const recordFailure = (code: MediaErrorCode, label?: string): MediaFailureDescriptor => {
    const failureDescriptor: MediaFailureDescriptor = {
      version: 1,
      state: stage === 'disabled' ? 'disabled' : 'rejected',
      code,
      inspection: 'uninspected',
      ...(label ? { label } : {}),
    };
    if (failures.length < MEDIA_LIMITS.maxImagesPerEvent) failures.push(failureDescriptor);
    return failureDescriptor;
  };

  /** Decide whether a recognized image is rejected, and with which code. */
  const rejectionCodeFor = (image: RecognizedImageBlock): MediaErrorCode | undefined => {
    const encodedLength = image.encodedBytes?.length ?? 0;
    if (stage === 'disabled') return 'converter_disabled';
    if (stage === 'reject') return 'source_too_large';
    if (recognizedImageCount > MEDIA_LIMITS.maxImagesPerEvent
      || encodedLength > MEDIA_LIMITS.maxInlineEncodedBytes
      || acceptedEncodedCharacters + encodedLength > MEDIA_LIMITS.maxInlineEncodedBytes) {
      return 'source_too_large';
    }
    // A declared unsupported format is rejected early. A missing declaration
    // is left to the worker, whose magic-byte check is the authority.
    if (image.declaredMimeType && !SUPPORTED_SOURCE_MIME_TYPES.has(image.declaredMimeType)) return 'unsupported_format';
    return undefined;
  };

  /** Walk every entry of a record except `skippedKey`, preserving identity when nothing changes. */
  const walkRecordEntries = (record: UnknownRecord, pointer: string, depth: number, skippedKey?: string): UnknownRecord => {
    const output: UnknownRecord = {};
    let changed = false;
    for (const [key, entry] of Object.entries(record)) {
      const next = key === skippedKey ? entry : walk(entry, `${pointer}/${escapeJsonPointerToken(key)}`, depth + 1);
      if (next !== entry) changed = true;
      // defineProperty keeps a hostile `__proto__` key an own data property.
      Object.defineProperty(output, key, { value: next, enumerable: true, writable: true, configurable: true });
    }
    return changed ? output : record;
  };

  const handleImageBlock = (block: UnknownRecord, image: RecognizedImageBlock, pointer: string, depth: number): UnknownRecord => {
    recognizedImageCount += 1;
    const label = `event1_image${recognizedImageCount}`;
    const encodedLength = image.encodedBytes?.length ?? 0;
    const rejectionCode = rejectionCodeFor(image);
    acceptedEncodedCharacters += encodedLength;
    if (!rejectionCode) {
      candidates.push({
        shape: image.shape,
        ...(image.encodedBytes !== undefined ? { encoded: image.encodedBytes } : {}),
        ...(image.trustedFilePath !== undefined ? { filePath: image.trustedFilePath } : {}),
        ...(image.declaredMimeType !== undefined ? { mimeType: image.declaredMimeType } : {}),
        pointer,
        label,
      });
    }

    // A typed file locator carries no bytes: the path stays as tool text.
    if (image.trustedFilePath !== undefined) {
      if (!rejectionCode && stage === 'dispatch') return walkRecordEntries(block, pointer, depth);
      const mediaStatus = rejectionCode
        ? recordFailure(rejectionCode, label)
        : { version: 1, state: 'captured', inspection: 'uninspected', label };
      return { ...walkRecordEntries(block, pointer, depth), media_status: mediaStatus };
    }

    // Dispatch keeps accepted bytes for the worker; everything around them is
    // still walked and counts toward the same image and node budget.
    if (!rejectionCode && stage === 'dispatch') {
      if (image.byteContainerKey === null) return walkRecordEntries(block, pointer, depth, image.byteFieldKey);
      const container = block[image.byteContainerKey] as UnknownRecord;
      const containerPointer = `${pointer}/${image.byteContainerKey}`;
      const walkedContainer = walkRecordEntries(container, containerPointer, depth + 1, image.byteFieldKey);
      const walkedBlock = walkRecordEntries(block, pointer, depth, image.byteContainerKey);
      if (walkedContainer === container) return walkedBlock;
      return { ...walkedBlock, [image.byteContainerKey]: walkedContainer };
    }

    // Elide only the byte field; sibling fields (Read's originalSize and
    // dimensions, Anthropic's source type) stay as observer signal.
    const elisionDescriptor: UnknownRecord = {
      elided: ELIDED_IMAGE_NOTE,
      bytes: encodedLength,
      ...(image.declaredMimeType ? { media_type: image.declaredMimeType } : {}),
    };
    const mediaStatus = rejectionCode
      ? recordFailure(rejectionCode, label)
      : { version: 1, state: 'captured', inspection: 'uninspected', label };

    if (image.byteContainerKey === null) {
      const blockWithoutBytes = withoutKey(block, image.byteFieldKey);
      return { ...walkRecordEntries(blockWithoutBytes, pointer, depth), ...elisionDescriptor, media_status: mediaStatus };
    }
    const container = block[image.byteContainerKey] as UnknownRecord;
    const containerWithoutBytes = withoutKey(container, image.byteFieldKey);
    const containerPointer = `${pointer}/${image.byteContainerKey}`;
    return {
      ...walkRecordEntries(block, pointer, depth, image.byteContainerKey),
      [image.byteContainerKey]: { ...walkRecordEntries(containerWithoutBytes, containerPointer, depth + 1), ...elisionDescriptor },
      media_status: mediaStatus,
    };
  };

  const walkString = (value: string, pointer: string, depth: number): unknown => {
    if (/^data:image\//i.test(value)) {
      return { elided: ELIDED_IMAGE_NOTE, bytes: value.length, media_status: recordFailure('unsupported_source') };
    }
    if (!looksLikeJsonText(value) || !IMAGE_MARKER_IN_JSON_TEXT.test(value)) return value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return value; // ordinary text stays text
    }
    const walked = walk(parsed, pointer, depth + 1);
    return walked === parsed ? value : JSON.stringify(walked);
  };

  const walk = (value: unknown, pointer: string, depth: number): unknown => {
    walkedNodeCount += 1;
    if (walkedNodeCount > MAX_WALKED_NODES || depth > MAX_WALK_DEPTH) {
      walkLimitReached = true;
      return value;
    }
    if (typeof value === 'string') return walkString(value, pointer, depth);
    if (Array.isArray(value)) {
      let changed = false;
      const output = value.map((entry, index) => {
        const next = walk(entry, `${pointer}/${index}`, depth + 1);
        if (next !== entry) changed = true;
        return next;
      });
      return changed ? output : value;
    }
    if (!isPlainRecord(value)) return value;
    const image = recognizeImageBlock(value);
    if (image) return handleImageBlock(value, image, pointer, depth);
    return walkRecordEntries(value, pointer, depth);
  };

  return {
    toolInput: walk(toolInput, '/tool_input', 0),
    toolResponse: walk(toolResponse, '/tool_response', 0),
    candidates,
    failures,
    walkLimitReached,
  };
}

export const LOCAL_EVENT_MAX_BYTES = 5 * 1024 * 1024;
const OVERSIZE_STRING_BYTES = 64 * 1024;
const OVERSIZE_STRING_KEPT_CHARS = 16 * 1024;
const OVERSIZE_FIELD_KEPT_CHARS = 32 * 1024;
const OVERSIZE_MAX_ENTRIES = 128;
const OVERSIZE_MARKER = '\n<elided reason="oversize" />\n';

function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Same useful head/tail discipline as the existing text field bounds. */
function clipOversizedValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_WALK_DEPTH) return value;
  if (typeof value === 'string' && Buffer.byteLength(value) > OVERSIZE_STRING_BYTES) {
    return value.slice(0, OVERSIZE_STRING_KEPT_CHARS) + OVERSIZE_MARKER + value.slice(-OVERSIZE_STRING_KEPT_CHARS);
  }
  if (Array.isArray(value)) return value.slice(0, OVERSIZE_MAX_ENTRIES).map(entry => clipOversizedValue(entry, depth + 1));
  if (isPlainRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, OVERSIZE_MAX_ENTRIES).map(([key, entry]) => [key, clipOversizedValue(entry, depth + 1)]));
  }
  return value;
}

function clipSerializedField(value: unknown): string {
  const text = JSON.stringify(value) ?? '';
  return text.slice(0, OVERSIZE_FIELD_KEPT_CHARS) + OVERSIZE_MARKER + text.slice(-OVERSIZE_FIELD_KEPT_CHARS);
}

/**
 * Pre-dispatch bound: keep useful text when image bodies would push the event
 * past the unchanged 5mb JSON cap. Image-free events under the cap are
 * returned with identical content.
 */
export function boundObservationDispatch<T extends { tool_input?: unknown; tool_response?: unknown }>(body: T): T {
  const dispatchScan = scanMediaFields(body.tool_input, body.tool_response, 'dispatch');
  const dispatchBody = { ...body, tool_input: dispatchScan.toolInput, tool_response: dispatchScan.toolResponse };
  if (serializedByteLength(dispatchBody) < LOCAL_EVENT_MAX_BYTES) return dispatchBody;

  const rejectScan = scanMediaFields(body.tool_input, body.tool_response, 'reject');
  let boundedBody = { ...body, tool_input: rejectScan.toolInput, tool_response: rejectScan.toolResponse };
  if (serializedByteLength(boundedBody) < LOCAL_EVENT_MAX_BYTES) return boundedBody;

  // Only an event still oversized after image removal takes this path.
  boundedBody = {
    ...boundedBody,
    tool_input: clipOversizedValue(boundedBody.tool_input),
    tool_response: clipOversizedValue(boundedBody.tool_response),
  };
  if (serializedByteLength(boundedBody) < LOCAL_EVENT_MAX_BYTES) return boundedBody;
  return {
    ...boundedBody,
    tool_input: clipSerializedField(boundedBody.tool_input),
    tool_response: clipSerializedField(boundedBody.tool_response),
  };
}
