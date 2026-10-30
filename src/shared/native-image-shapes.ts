/**
 * Shape predicates for the native image content blocks that tools return.
 *
 * Shared by the media capture scanner (shared/media-ingress.ts) and the
 * observer prompt stripper (sdk/prompts.ts) so the two recognizers cannot
 * drift apart. Only the shape is decided here; what to do with a match
 * (capture, elide, or leave alone) stays with each caller.
 */
export type UnknownRecord = Record<string, unknown>;

export function isPlainRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Anthropic content block: `{ type: 'image', source: { type, media_type, data | url } }`. */
export function anthropicImageSourceOf(block: UnknownRecord): UnknownRecord | undefined {
  return block.type === 'image' && isPlainRecord(block.source) ? block.source : undefined;
}

/**
 * Claude Code Read result for an image file:
 * `{ type: 'image', file: { base64, type: 'image/png', originalSize, dimensions } }`.
 * A typed local locator (`file: { path }`) uses the same container.
 */
export function claudeReadImageFileOf(block: UnknownRecord): UnknownRecord | undefined {
  return block.type === 'image' && isPlainRecord(block.file) ? block.file : undefined;
}

/** MCP tool result block with the bytes on the block itself: `{ type: 'image', data, mimeType }`. */
export function isMcpInlineImageBlock(block: UnknownRecord): boolean {
  return block.type === 'image' && typeof block.data === 'string';
}

/** OpenAI content block: `{ type: 'image_url', image_url: { url } }`. */
export function openAiImageUrlOf(block: UnknownRecord): UnknownRecord | undefined {
  return block.type === 'image_url' && isPlainRecord(block.image_url) ? block.image_url : undefined;
}

/**
 * The MIME a Read result declares. Real Claude Code results name it
 * `file.type`; `file.media_type` is still accepted. The declaration is only a
 * hint: the worker's magic-byte check decides the format actually converted.
 */
export function declaredReadImageMimeType(readImageFile: UnknownRecord): string | undefined {
  const declaredMimeType = typeof readImageFile.media_type === 'string'
    ? readImageFile.media_type
    : readImageFile.type;
  if (typeof declaredMimeType !== 'string' || !/^image\//i.test(declaredMimeType)) return undefined;
  return declaredMimeType.toLowerCase();
}
