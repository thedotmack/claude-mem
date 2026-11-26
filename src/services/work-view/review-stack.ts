import { createHash } from 'node:crypto';
import {
  REVIEW_STACK_CARD_KIND, isReviewStackKind,
  type ReviewStackAction, type ReviewStackBookmark, type ReviewStackCard, type ReviewStackFollowUp,
  type ReviewStackGroup, type ReviewStackImportCard, type ReviewStackImportResult, type ReviewStackPage,
  type ReviewStackRecordKind, type ReviewStackReview, type ReviewStackSnapshot, type ReviewStackWriteResult,
} from '../../shared/review-stack.js';
import { canonicalJson, compareCanonicalDecimals } from '../sync/CanonicalContent.js';
import { SHARED_WORK_MAX_UPDATES, SHARED_WORK_MAX_VALUE_BYTES } from './shared-records.mjs';
import {
  assertMutationId, cardId, decodeImage, focusKey, focusIdFor, GROUP_CHUNK, hexDigest, IMAGE_CHUNK, MAX_EXCERPT_PARTS,
  imageParts, isReviewStackImagePart, isReviewStackValue, parseAction, parseImport, ReviewStackError,
  type GroupMember, type StoredCard, type StoredEvent, type StoredReceipt,
} from './review-stack-schema.js';

export { ReviewStackError, isReviewStackValue } from './review-stack-schema.js';
export { REVIEW_STACK_CARD_KIND, REVIEW_STACK_CARD_TOOL_SCHEMA, REVIEW_STACK_IMPORT_LIMIT, isReviewStackKind } from '../../shared/review-stack.js';

export interface ReviewStackRecord {
  kind: string; key: string; value: unknown; hash: string; revision: string; deleted: boolean;
  writer?: string; batchId?: string; sourceId?: number | string; valueHash?: string;
  /** The host already validated this manifest member and omitted image bytes while reading a page. */
  valueOmitted?: true;
}
export interface ReviewStackUpdate { kind: ReviewStackRecordKind; key: string; value: unknown; expectedHash: string | null }
type DisclosureOptions = { redactText?: (text: string) => string };
type ReadOptions = DisclosureOptions & { thumbnailUrl?: (cardId: string, imageHash: string) => string };
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const identity = (kind: string, key: string) => kind + '/' + key;
const partKey = (id: string, contentId: string, type: 'image' | 'excerpt', n: number) =>
  id + ':' + contentId + ':' + type + ':' + n;
const stale = () => new ReviewStackError(409, 'This review changed. Refresh the stack and try again.');
const missing = () => new ReviewStackError(404, 'This item is no longer in your review stack.');
const conflict = () => new ReviewStackError(409, 'This action ID was already used for a different change.');

/** Same winner ordering as cloud-renderer-core.mjs: revision, then origin writer, then batch ID. */
export function reviewStackWinners(records: Iterable<ReviewStackRecord>): ReviewStackRecord[] {
  const winners = new Map<string, ReviewStackRecord>();
  for (const record of records) {
    if (!isReviewStackKind(record.kind)) continue;
    const imageHead = record.valueOmitted === true && record.kind === 'stack-part' && isReviewStackImagePart(record.key);
    if (!imageHead && !isReviewStackValue(record.kind, record.key, record.value, record.deleted)) continue;
    const key = identity(record.kind, record.key);
    const prior = winners.get(key);
    if (!prior || (compareCanonicalDecimals(record.revision, prior.revision)
      || cmp(record.writer ?? '', prior.writer ?? '') || cmp(record.batchId ?? '', prior.batchId ?? '')) > 0) {
      winners.set(key, record);
    }
  }
  return [...winners.values()];
}

function indexRecords(records: Iterable<ReviewStackRecord>) {
  const winners = reviewStackWinners(records);
  const rows = new Map(winners.map(r => [identity(r.kind, r.key), r]));
  const get = <T>(kind: ReviewStackRecordKind, key: string): T | undefined => {
    const row = rows.get(identity(kind, key));
    return row && !row.deleted ? row.value as T : undefined;
  };
  return { winners, rows, get };
}
type RecordIndex = ReturnType<typeof indexRecords>;
function parts(index: RecordIndex, id: string, card: StoredCard, type: 'excerpt' | 'image'): string[] | null {
  const values = [];
  const count = type === 'image' ? card.imageParts : card.excerptParts;
  for (let n = 0; n < count; n++) {
    const part = index.get<string>('stack-part', partKey(id, card.contentId, type, n));
    if (typeof part !== 'string') return null;
    values.push(part);
  }
  return values;
}
function imageFrom(index: RecordIndex, id: string, card: StoredCard) {
  if (!card.imageType) return null;
  const chunks = parts(index, id, card, 'image');
  if (!chunks) return null;
  const encoded = chunks.join('');
  if (hexDigest(encoded) !== card.imageHash) return null;
  const bytes = decodeImage(card.imageType, encoded);
  return bytes ? { mimeType: card.imageType, bytes } : null;
}
export function reviewStackImage(records: Iterable<ReviewStackRecord>, id: string,
  loadValue?: (head: ReviewStackRecord) => unknown, expectedImageHash?: string): { bytes: Uint8Array; mimeType: string } | null {
  // A native reader holds every current head. Never materialize or validate another card's image for this request.
  const relevant: ReviewStackRecord[] = [];
  const prefix = id + ':';
  for (const row of records) {
    if ((row.kind === REVIEW_STACK_CARD_KIND && row.key === id)
      || (row.kind === 'stack-part' && row.key.startsWith(prefix) && isReviewStackImagePart(row.key))) relevant.push(row);
  }
  const heads = indexRecords(relevant);
  const card = heads.get<StoredCard>(REVIEW_STACK_CARD_KIND, id);
  if (!card || (expectedImageHash !== undefined && card.imageHash !== expectedImageHash)) return null;
  if (loadValue) {
    for (let n = 0; n < card.imageParts; n++) {
      const key = partKey(id, card.contentId, 'image', n);
      const mapKey = identity('stack-part', key);
      const row = heads.rows.get(mapKey);
      if (!row || row.deleted) return null;
      if (row.valueOmitted) {
        const value = loadValue(row);
        if (!isReviewStackValue('stack-part', key, value)) return null;
        heads.rows.set(mapKey, { ...row, value, valueOmitted: undefined });
      }
    }
  }
  return imageFrom(heads, id, card);
}
function readCard(index: RecordIndex, id: string, meta: StoredCard, options: ReadOptions): ReviewStackCard | null {
  const { contentId, excerptParts, imageParts: partCount, imageType, imageHash, ...fields } = meta;
  // Earlier cards contain the original label alone. New writes carry its
  // identity through recipient redaction even if two areas display the same text.
  const card: ReviewStackCard = { ...fields, id, focusId: meta.focusId ?? focusIdFor(meta.focus) };
  if (excerptParts) {
    const text = parts(index, id, meta, 'excerpt');
    if (!text) return null;
    card.excerpt = text.join('');
  }
  if (partCount && imageType && imageHash) {
    // The dedicated media read rechecks image bytes before serving them. A deck page
    // needs only the authenticated URL and never serializes thumbnails unnecessarily.
    if (options.thumbnailUrl) {
      for (let n = 0; n < partCount; n++) {
        const head = index.rows.get(identity('stack-part', partKey(id, contentId, 'image', n)));
        if (!head || head.deleted) return null;
      }
      card.preview = options.thumbnailUrl(id, imageHash);
    }
    else {
      const chunks = parts(index, id, meta, 'image');
      if (!chunks) return null;
      const encoded = chunks.join('');
      if (hexDigest(encoded) !== imageHash || !decodeImage(imageType, encoded)) return null;
      card.imageData = 'data:' + imageType + ';base64,' + encoded;
    }
  }
  return card;
}
/** Disclose authored text separately from IDs, verified image bytes and host-generated media URLs. */
function discloseCard<T extends ReviewStackImportCard>(
  card: T, id: string, redactText: DisclosureOptions['redactText'], generatedPreview = false,
): T {
  if (!redactText) return card;
  const copy = {
    ...card, key: redactText(card.key) === card.key ? card.key : id, focus: redactText(card.focus),
    title: redactText(card.title), what: redactText(card.what), context: redactText(card.context),
  };
  if (card.excerpt !== undefined) copy.excerpt = redactText(card.excerpt);
  // Redacting part of an authored URL can change its destination. Omit the entire link.
  if (card.source !== undefined && redactText(card.source) !== card.source) delete copy.source;
  if (!generatedPreview && card.preview !== undefined && redactText(card.preview) !== card.preview) delete copy.preview;
  return copy;
}
interface ActiveGroup {
  summary: ReviewStackGroup;
  displaced: Map<string, ReviewStackReview | undefined>;
}
function emptyState() {
  return {
    cards: new Map<string, ReviewStackCard>(), reviews: new Map<string, ReviewStackReview>(),
    bookmarks: new Map<string, ReviewStackBookmark>(), followUps: new Map<string, ReviewStackFollowUp>(),
    groups: new Map<string, ActiveGroup>(), clock: 0,
  };
}
type State = ReturnType<typeof emptyState>;

/** One UUID per member keeps history items individually undoable, including after another device receives a group. */
function groupReviewId(group: string, id: string) {
  const hex = hexDigest(group + ':' + id);
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16)
    + '-8' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}
function changeReview(state: State, id: string, incoming?: ReviewStackReview) {
  const old = state.reviews.get(id);
  if (old?.groupId) {
    const group = state.groups.get(old.groupId);
    if (group) group.summary.activeCount--;
  }
  if (incoming) state.reviews.set(id, incoming);
  else state.reviews.delete(id);
}
function applyAction(state: State, id: string, input: ReviewStackAction, at: number, members: GroupMember[], groupFocusId?: string) {
  if (input.action !== 'seen-group' && 'cardId' in input && !state.cards.has(input.cardId)) throw missing();
  switch (input.action) {
    case 'seen':
    case 'skip': {
      const current = state.reviews.get(input.cardId);
      if ((current?.id ?? null) !== input.expectedReviewId || current?.action === 'seen') throw stale();
      changeReview(state, input.cardId, { id, cardId: input.cardId, action: input.action, createdAt: at });
      break;
    }
    case 'undo': {
      if (state.reviews.get(input.cardId)?.id !== input.reviewId) throw stale();
      changeReview(state, input.cardId);
      break;
    }
    case 'bookmark': {
      const current = state.bookmarks.get(input.cardId);
      if ((current?.revision ?? 0) !== input.revision) throw stale();
      if (current?.saved !== input.saved) state.bookmarks.set(input.cardId, {
        cardId: input.cardId, saved: input.saved, revision: input.revision + 1,
      });
      break;
    }
    case 'follow-up':
      state.followUps.set(id, { id, cardId: input.cardId, body: input.body, createdAt: at, closedAt: null, revision: 1 });
      break;
    case 'set-follow-up': {
      const note = state.followUps.get(input.followUpId);
      if (!note || note.cardId !== input.cardId) throw missing();
      if (note.revision !== input.revision) throw stale();
      if ((note.closedAt !== null) !== input.closed) {
        state.followUps.set(note.id, { ...note, closedAt: input.closed ? at : null, revision: note.revision + 1 });
      }
      break;
    }
    case 'seen-group': {
      const displaced: ActiveGroup['displaced'] = new Map();
      const firstMatch = groupFocusId ? undefined : members.map(m => state.cards.get(m.cardId))
        .find(card => card && focusKey(card.focus) === focusKey(input.focus));
      const focusId = groupFocusId ?? firstMatch?.focusId ?? focusIdFor(input.focus);
      let label = input.focus;
      for (const member of members) {
        const card = state.cards.get(member.cardId);
        const old = state.reviews.get(member.cardId);
        // Preserve the original area and the decision observed by its writer,
        // regardless of how the recipient currently discloses that area's name.
        if (!card || card.focusId !== focusId || (old?.id ?? null) !== member.previous || old?.action === 'seen') continue;
        if (groupFocusId) label = card.focus;
        displaced.set(card.id, old);
        changeReview(state, card.id, { id: groupReviewId(id, card.id), cardId: card.id, groupId: id, action: 'seen', createdAt: at });
      }
      state.groups.set(id, {
        summary: { id, focus: label, focusId, createdAt: at, count: displaced.size, activeCount: displaced.size }, displaced,
      });
      break;
    }
    case 'undo-group': {
      const group = state.groups.get(input.groupId);
      if (!group) throw stale();
      for (const [card, old] of group.displaced) {
        if (state.reviews.get(card)?.groupId === input.groupId) changeReview(state, card, old);
      }
      state.groups.delete(input.groupId);
      break;
    }
  }
}
function readState(index: RecordIndex, options: ReadOptions) {
  const state = emptyState();
  const events: { id: string; value: StoredEvent }[] = [];
  for (const row of index.winners) {
    if (row.deleted) continue;
    if (row.kind === REVIEW_STACK_CARD_KIND) {
      const card = readCard(index, row.key, row.value as StoredCard, options);
      if (card) state.cards.set(card.id, card);
    } else if (row.kind === 'stack-event') events.push({ id: row.key, value: row.value as StoredEvent });
  }
  // The logical clock is derived from every action known to its writer. Wall-clock skew can never
  // order an undo before the swipe it observed. Offline siblings use the same UUID tie-break everywhere.
  events.sort((a, b) => a.value.order - b.value.order || cmp(a.id, b.id));
  for (const { id, value } of events) {
    state.clock = Math.max(state.clock, value.order);
    const members: GroupMember[] = [];
    let complete = true;
    for (let n = 0; n < value.parts; n++) {
      const part = index.get<GroupMember[]>('stack-group-part', id + ':' + n);
      if (!part) { complete = false; break; }
      members.push(...part);
    }
    if (!complete) continue;
    try { applyAction(state, id, value.input, value.createdAt, members, value.focusId); }
    catch (error) {
      // A losing concurrent action is still a receipt. It cannot overwrite the winning decision on replay.
      if (!(error instanceof ReviewStackError)) throw error;
    }
  }
  return state;
}
export function renderReviewStack(records: Iterable<ReviewStackRecord>, options: ReadOptions = {}): ReviewStackSnapshot {
  const index = indexRecords(records);
  const state = readState(index, options);
  const revision = createHash('sha256');
  for (const row of [...index.winners].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.key, b.key))) {
    revision.update(canonicalJson([row.kind, row.key, row.hash, row.revision, row.valueHash ?? row.hash]));
  }
  const newest = (a: { createdAt: number; id: string }, b: { createdAt: number; id: string }) =>
    b.createdAt - a.createdAt || cmp(a.id, b.id);
  const cards = [...state.cards.values()].sort(newest).map(card => {
    const meta = index.get<StoredCard>(REVIEW_STACK_CARD_KIND, card.id)!;
    return discloseCard(card, card.id, options.redactText, !!options.thumbnailUrl && meta.imageParts > 0);
  });
  const followUps = [...state.followUps.values()].sort(newest).map(note => options.redactText
    ? { ...note, body: options.redactText(note.body) } : note);
  const groups = [...state.groups.values()].map(g => g.summary).sort(newest).map(group => options.redactText
    ? { ...group, focus: options.redactText(group.focus) } : group);
  // A changed policy can affect existing metadata and notes without a shared write.
  // Pin the actual disclosure in deterministic order; verified image bytes are already bound by their head hashes.
  for (const { imageData, preview, ...metadata } of cards) {
    const manifest = index.get<StoredCard>(REVIEW_STACK_CARD_KIND, metadata.id)!;
    // An authenticated thumbnail path depends on the host, while the original
    // payload and any policy-controlled external preview belong to the deck.
    const authoredPreview = manifest.imageParts ? manifest.preview : preview;
    if (authoredPreview !== undefined && (!options.redactText || options.redactText(authoredPreview) === authoredPreview)) {
      revision.update(canonicalJson(authoredPreview));
    }
    revision.update(canonicalJson(metadata));
  }
  for (const note of followUps) revision.update(canonicalJson([note.id, note.body]));
  for (const group of groups) revision.update(canonicalJson([group.id, group.focus]));
  return {
    revision: revision.digest('hex'), cards,
    reviews: [...state.reviews.values()].sort(newest), bookmarks: [...state.bookmarks.values()].sort((a, b) => cmp(a.cardId, b.cardId)),
    followUps, groups,
  };
}

const PAGE_BYTES = 512 * 1024;
/** Page the collections together so even a single card with many follow-ups has a bounded response. */
export function reviewStackPage(snapshot: ReviewStackSnapshot, cursor?: string | null): ReviewStackPage {
  let offset = 0;
  if (cursor != null) {
    const match = /^([a-f0-9]{64})\.(0|[1-9]\d{0,14})$/.exec(cursor);
    if (!match) throw new ReviewStackError(400, 'Invalid review stack cursor.');
    if (match[1] !== snapshot.revision) throw stale();
    offset = Number(match[2]);
  }
  const page: ReviewStackPage = { revision: snapshot.revision, cards: [], reviews: [], bookmarks: [], followUps: [], groups: [], nextCursor: null };
  let position = 0;
  let size = 512; // envelope including revision and next cursor
  function add<T>(all: T[], output: T[]) {
    if (offset >= position + all.length) { position += all.length; return true; }
    const first = Math.max(0, offset - position);
    position += first;
    for (let i = first; i < all.length; i++) {
      const item = all[i];
      const cost = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (size + cost > PAGE_BYTES) {
        if (position === offset) throw new ReviewStackError(413, 'This review item exceeds the page size.');
        page.nextCursor = snapshot.revision + '.' + position;
        return false;
      }
      output.push(item);
      size += cost;
      position++;
    }
    return true;
  }
  if (add(snapshot.cards, page.cards) && add(snapshot.reviews, page.reviews) && add(snapshot.bookmarks, page.bookmarks)
    && add(snapshot.followUps, page.followUps)) add(snapshot.groups, page.groups);
  if (position < offset) throw new ReviewStackError(400, 'Invalid review stack cursor.');
  return page;
}

function excerptParts(excerpt: string): string[] {
  if (!excerpt) return [];
  // Keeping the whole readable scalar together lets each native recipient apply
  // its own redaction patterns before storing the row, even across a long line.
  if (Buffer.byteLength(JSON.stringify(excerpt)) <= SHARED_WORK_MAX_VALUE_BYTES) return [excerpt];
  const parts: string[] = [];
  let part = '';
  let used = 2; // JSON quotes
  for (const point of excerpt) {
    const size = Buffer.byteLength(JSON.stringify(point)) - 2;
    if (used + size > SHARED_WORK_MAX_VALUE_BYTES) {
      parts.push(part);
      if (parts.length >= MAX_EXCERPT_PARTS) throw new ReviewStackError(413, 'This review excerpt exceeds the shared record limit.');
      part = '';
      used = 2;
    }
    part += point;
    used += size;
  }
  return [...parts, part];
}
function importedUpdates(card: ReviewStackImportCard, now: number, options: DisclosureOptions,
  add: (kind: ReviewStackRecordKind, key: string, value: unknown) => void) {
  const id = cardId(card.key);
  const disclosed = discloseCard(card, id, options.redactText);
  if (disclosed.key !== card.key) throw new ReviewStackError(400, 'Choose a stable asset key that your redaction settings can store.');
  const { excerpt, imageData, ...copy } = disclosed;
  if (!excerpt && !imageData && !copy.source && !copy.preview) {
    throw new ReviewStackError(400, 'The original link is hidden by your redaction settings. Include an excerpt or a thumbnail.');
  }
  // The manifest points only to this import's parts even if two offline devices import different originals under the same key.
  const contentId = hexDigest(canonicalJson(disclosed));
  const chunks = excerptParts(excerpt ?? '');
  const image = imageData ? imageParts(imageData) : null;
  const meta: StoredCard = {
    ...copy, focusId: focusIdFor(card.focus), contentId, createdAt: now, excerptParts: chunks.length,
    imageParts: image ? Math.ceil(image.data.length / IMAGE_CHUNK) : 0, imageType: image?.type ?? null,
    imageHash: image ? hexDigest(image.data) : null,
  };
  add(REVIEW_STACK_CARD_KIND, id, meta);
  for (const [n, chunk] of chunks.entries()) add('stack-part', partKey(id, contentId, 'excerpt', n), chunk);
  if (image) for (let n = 0; n < meta.imageParts; n++) {
    add('stack-part', partKey(id, contentId, 'image', n), image.data.slice(n * IMAGE_CHUNK, (n + 1) * IMAGE_CHUNK));
  }
}
export function prepareReviewStackWrite(
  records: Iterable<ReviewStackRecord>, operation: 'import' | 'action', input: unknown, mutationId: string, now = Date.now(),
  options: DisclosureOptions = {},
): { updates: ReviewStackUpdate[]; result: ReviewStackWriteResult } {
  assertMutationId(mutationId);
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) {
    throw new ReviewStackError(400, 'Invalid review timestamp.');
  }
  const index = indexRecords(records);
  const updates: ReviewStackUpdate[] = [];
  const add = (kind: ReviewStackRecordKind, key: string, value: unknown) => {
    if (updates.length >= SHARED_WORK_MAX_UPDATES || Buffer.byteLength(canonicalJson(value)) > SHARED_WORK_MAX_VALUE_BYTES) {
      throw new ReviewStackError(413, 'This review change exceeds the shared record limit.');
    }
    updates.push({ kind, key, value, expectedHash: index.rows.get(identity(kind, key))?.hash ?? null });
  };
  const receipt = index.get<StoredReceipt>('stack-receipt', mutationId);
  const previous = index.get<StoredEvent>('stack-event', mutationId);
  if (operation === 'import') {
    const cards = parseImport(input);
    const fingerprint = hexDigest(canonicalJson(cards));
    if (previous || (receipt && receipt.fingerprint !== fingerprint)) throw conflict();
    if (receipt) {
      const { fingerprint: storedFingerprint, ...result } = receipt;
      return { updates, result };
    }
    const seen = new Set<string>();
    let added = 0;
    for (const card of cards) {
      const id = cardId(card.key);
      if (seen.has(id) || index.get(REVIEW_STACK_CARD_KIND, id)) continue;
      importedUpdates(card, now, options, add);
      seen.add(id);
      added++;
    }
    const result: ReviewStackImportResult = { added, existing: cards.length - added, firstId: cardId(cards[0].key) };
    add('stack-receipt', mutationId, { fingerprint, ...result });
    return { updates, result };
  }
  const parsedAction = parseAction(input);
  const fingerprint = hexDigest(canonicalJson(parsedAction));
  if (receipt || (previous && previous.fingerprint !== fingerprint)) throw conflict();
  if (previous) return { updates, result: { ok: true } };
  let action = options.redactText && parsedAction.action === 'follow-up'
    ? { ...parsedAction, body: options.redactText(parsedAction.body) } : parsedAction;
  const state = readState(index, { thumbnailUrl: id => id });
  const members: GroupMember[] = [];
  let groupFocusId: string | undefined;
  if (action.action === 'seen-group') {
    const selected = focusKey(action.focus);
    const displayKey = (card: ReviewStackCard) => focusKey(options.redactText?.(card.focus) ?? card.focus);
    const anchor = action.cardId ? state.cards.get(action.cardId) : undefined;
    if (action.cardId && !anchor) throw missing();
    if (anchor && displayKey(anchor) !== selected) throw stale();
    const matching = anchor ? [anchor] : [...state.cards.values()].filter(c => displayKey(c) === selected);
    if (!matching.length) throw missing();
    const scope = matching[0].focusId!;
    if (matching.some(c => c.focusId !== scope)) throw stale();
    const groupCards = [...state.cards.values()].filter(c => c.focusId === scope);
    for (const card of groupCards.sort((a, b) => cmp(a.id, b.id))) {
      const review = state.reviews.get(card.id);
      if (review?.action !== 'seen') members.push({ cardId: card.id, previous: review?.id ?? null });
    }
    groupFocusId = scope;
    // The anchor is a request precondition. Keep the shared action's original
    // input shape; its separate scope survives redaction at a receiving device.
    action = { action:'seen-group', focus:action.focus };
  }
  // Check CAS and existence in the same owner transaction in which the adapter commits these records.
  applyAction(state, mutationId, action, now, members, groupFocusId);
  const count = Math.ceil(members.length / GROUP_CHUNK);
  for (let n = 0; n < count; n++) add('stack-group-part', mutationId + ':' + n, members.slice(n * GROUP_CHUNK, (n + 1) * GROUP_CHUNK));
  add('stack-event', mutationId, { input: action, fingerprint, createdAt: now, order: state.clock + 1, parts: count,
    ...(groupFocusId && {focusId:groupFocusId}) } satisfies StoredEvent);
  return { updates, result: { ok: true } };
}
