import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SHARED_WORK_MAX_VALUE_BYTES } from './shared-records.mjs';
import {
  REVIEW_STACK_IMAGE_BYTES, REVIEW_STACK_IMPORT_LIMIT, REVIEW_STACK_VERDICTS, reviewStackFocusKey,
  type ReviewStackAction, type ReviewStackImportCard,
} from '../../shared/review-stack.js';

export class ReviewStackError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413, message: string) { super(message); }
}
export const hexDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export const cardId = (key: string) => 'weekly-' + hexDigest(key);
const cardIdPattern = /^weekly-[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(uuidPattern, 'Use a UUID for this review action.');
const asset = z.string().regex(cardIdPattern, 'Choose a card from your stack.');
const safeInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = safeInt.max(8_640_000_000_000_000);
const text = (max: number) => z.string().trim().min(1).max(max).refine(s => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(s), 'Use readable text.');
const words = (min: number, max: number, charLimit: number, label: string) => text(charLimit)
  .transform(s => s.split(/\s+/u).join(' '))
  .refine(s => s.split(' ').length >= min && s.split(' ').length <= max, label + ' needs ' + min + '–' + max + ' words.');
const focus = text(64).transform(s => s.split(/\s+/u).join(' '));
export const focusKey = reviewStackFocusKey;
const url = z.string().trim().max(4096).refine(s => {
  if (!s.startsWith('https://') || /[\s\x00-\x1f\x7f\\]/u.test(s)) return false;
  try {
    const parsed = new URL(s);
    return parsed.protocol === 'https:' && parsed.hostname.includes('.') && !parsed.username && !parsed.password;
  } catch { return false; }
}, 'Use an original HTTPS link.');
const metadata = {
  key: text(4096), focus, title: words(3, 5, 120, 'Title'),
  what: words(10, 15, 360, 'Description'), context: words(10, 15, 360, 'Context'),
  source: url.optional(), preview: url.optional(),
};
export const IMAGE_CHUNK = 32_000;  // Base64 characters; split on complete quartets.
export const MAX_EXCERPT_PARTS = 4;
export const GROUP_CHUNK = 200;
const imageTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageType = typeof imageTypes[number];
const inlineImage = z.string().max(4 * Math.ceil(REVIEW_STACK_IMAGE_BYTES / 3) + 40);
export function decodeImage(mimeType: ImageType, encoded: string): Buffer | null {
  if (!encoded || encoded.length > 4 * Math.ceil(REVIEW_STACK_IMAGE_BYTES / 3)
    || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > REVIEW_STACK_IMAGE_BYTES || bytes.toString('base64') !== encoded) return null;
  const valid = mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : mimeType === 'image/jpeg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return valid ? bytes : null;
}
export function imageParts(data: string) {
  const matched = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!matched || !decodeImage(matched[1] as ImageType, matched[2])) {
    throw new ReviewStackError(400, 'Use an original PNG, JPEG or WebP thumbnail of up to 160 KiB.');
  }
  return { type: matched[1] as ImageType, data: matched[2] };
}
const importCard = z.strictObject({ ...metadata, imageData: inlineImage.optional(), excerpt: text(16_000).optional() })
  .refine(c => Boolean(c.source || c.preview || c.imageData || c.excerpt), 'Include the original source, preview or an excerpt.');
const importBody = z.strictObject({ cards: z.array(importCard).min(1).max(REVIEW_STACK_IMPORT_LIMIT) });
export function parseImport(input: unknown): ReviewStackImportCard[] {
  const result = importBody.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const location = typeof issue.path[1] === 'number' ? 'Card ' + (issue.path[1] + 1) + '. ' : '';
    throw new ReviewStackError(400, location + issue.message);
  }
  for (const card of result.data.cards) if (card.imageData) imageParts(card.imageData);
  return result.data.cards;
}
export const storedCard = z.strictObject({
  // Word counts guide authored copy. A recipient's redaction marker can replace
  // one word with two without changing the identity of a previously valid card.
  ...metadata, title: metadata.title.or(redactedCopy()), what: metadata.what.or(redactedCopy()), context: metadata.context.or(redactedCopy()),
  contentId: digest, createdAt: time, excerptParts: safeInt.max(MAX_EXCERPT_PARTS),
  imageParts: safeInt.max(Math.ceil(4 * Math.ceil(REVIEW_STACK_IMAGE_BYTES / 3) / IMAGE_CHUNK)),
  imageType: z.enum(imageTypes).nullable(), imageHash: digest.nullable(),
}).refine(c => (c.imageType === null) === (c.imageParts === 0) && (c.imageHash === null) === (c.imageParts === 0)
  && Boolean(c.source || c.preview || c.excerptParts || c.imageParts));
export type StoredCard = z.infer<typeof storedCard>;
function redactedCopy() {
  return text(SHARED_WORK_MAX_VALUE_BYTES).refine(s => /<redacted type='[^']+'\/>/u.test(s));
}
const actionSchemas = [
  z.strictObject({ action: z.enum(REVIEW_STACK_VERDICTS), cardId: asset, expectedReviewId: uuid.nullable() }),
  z.strictObject({ action: z.literal('undo'), cardId: asset, reviewId: uuid }),
  z.strictObject({ action: z.literal('bookmark'), cardId: asset, saved: z.boolean(), revision: safeInt }),
  z.strictObject({ action: z.literal('follow-up'), cardId: asset, body: text(4000) }),
  z.strictObject({ action: z.literal('set-follow-up'), cardId: asset, followUpId: uuid, closed: z.boolean(), revision: safeInt }),
  z.strictObject({ action: z.literal('seen-group'), focus }),
  z.strictObject({ action: z.literal('undo-group'), groupId: uuid }),
] as const;
const actionBody = z.discriminatedUnion('action', actionSchemas);
export function parseAction(value: unknown): ReviewStackAction {
  const result = actionBody.safeParse(value);
  if (!result.success) throw new ReviewStackError(400, result.error.issues[0].message);
  return result.data;
}
export function assertMutationId(id: string) {
  if (!uuidPattern.test(id)) throw new ReviewStackError(400, 'Use a fresh UUID in Idempotency-Key.');
}
const event = z.strictObject({ input: actionBody, fingerprint: digest, createdAt: time, order: safeInt.min(1), parts: safeInt.max(511) })
  .refine(e => e.parts === 0 || e.input.action === 'seen-group');
export type StoredEvent = z.infer<typeof event>;
const members = z.array(z.strictObject({ cardId: asset, previous: uuid.nullable() })).min(1).max(GROUP_CHUNK);
export type GroupMember = z.infer<typeof members>[number];
const receipt = z.strictObject({ fingerprint: digest, added: safeInt, existing: safeInt, firstId: asset });
export type StoredReceipt = z.infer<typeof receipt>;
const partKey = /^(weekly-[a-f0-9]{64}):[a-f0-9]{64}:(excerpt|image):([0-6])$/;
export const isReviewStackImagePart = (key: string) => partKey.exec(key)?.[2] === 'image';
const groupPartKey = /^([0-9a-f-]{36}):(0|[1-9]\d{0,2})$/;
/** Domain verification is part of the existing atomic shared-batch validator, on both ends. */
export function isReviewStackValue(kind: string, key: string, value: unknown, deleted = false): boolean {
  switch (kind) {
    case 'stack-card': {
      if (!cardIdPattern.test(key)) return false;
      if (deleted) return true;
      const data = storedCard.safeParse(value);
      return data.success && cardId(data.data.key) === key;
    }
    case 'stack-part': {
      const match = partKey.exec(key);
      if (!match) return false;
      if (deleted) return true;
      return typeof value === 'string' && !!value && (match[2] === 'image'
        ? value.length <= IMAGE_CHUNK && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
        : Number(match[3]) < MAX_EXCERPT_PARTS && Buffer.byteLength(JSON.stringify(value)) <= SHARED_WORK_MAX_VALUE_BYTES);
    }
    case 'stack-event': return uuidPattern.test(key) && (deleted || event.safeParse(value).success);
    case 'stack-receipt': return uuidPattern.test(key) && (deleted || receipt.safeParse(value).success);
    case 'stack-group-part': {
      const match = groupPartKey.exec(key);
      return !!match && uuidPattern.test(match[1]) && Number(match[2]) < 511 && (deleted || members.safeParse(value).success);
    }
    default: return false;
  }
}
