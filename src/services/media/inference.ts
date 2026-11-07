import { MEDIA_LIMITS, MediaError, type MediaAttachmentRef } from '../../shared/media-contract.js';
import { logger } from '../../utils/logger.js';
import { LOCAL_IMAGE_REQUEST_BOUNDS, type ImageRequestBounds } from '../worker/media-capability.js';

/**
 * The per-turn image side of an observer request (docs/media-contract-v1.md,
 * "Request image parts" and "Observation XML attachment refs").
 *
 * Conversation history stays string content. Only the request being sent for
 * the current observation turn carries image parts, materialized here from the
 * retained LLM derivatives; nothing in this module touches history, summaries,
 * compression or condensation.
 */

/** One source event of the turn, in request order. `ordinal` is the E in `event<E>_image<N>`. */
export interface TurnMediaEvent {
  eventKey: string;
  ordinal: number;
}

/** The frozen request label → source mapping for one image the request carries. */
export interface TurnImageLabel {
  requestLabel: string;
  eventOrdinal: number;
  eventKey: string;
  attachmentId: string;
  eventLabel: string;
}

/** A label plus the derivative's data URL; held only for the duration of one request. */
export interface TurnImage extends TurnImageLabel {
  dataUrl: string;
}

export interface PreparedTurnMedia {
  events: TurnMediaEvent[];
  images: TurnImage[];
  /** The capability's request body bound; images that would exceed it are left out. */
  maxBodyBytes: number;
}

/** What the observation path hands the provider for one request. */
export interface TurnImageRequest {
  images: readonly TurnImage[];
  maxBodyBytes: number;
}

/** Frozen into the response context when the request is sent; never re-derived from session state. */
export interface ResponseMediaContext {
  readonly events: readonly Readonly<TurnMediaEvent>[];
  readonly images: readonly Readonly<TurnImageLabel>[];
  /** True only when the accepted request actually carried these images' pixels. */
  readonly imagesDelivered: boolean;
}

const EVENT_LABEL = /^event1_image([1-4])$/;
const REQUEST_LABEL = /^event[1-9][0-9]{0,2}_image[1-4]$/;
const WEBP_DATA_URL_PREFIX = 'data:image/webp;base64,';

/** The source events of a turn, in message order; messages without media refs carry no event. */
export function turnMediaEvents(messages: ReadonlyArray<{ mediaEventKey?: string; mediaRefs?: MediaAttachmentRef[] }>): TurnMediaEvent[] {
  const events: TurnMediaEvent[] = [];
  messages.forEach((message, index) => {
    if (message.mediaEventKey && message.mediaRefs?.length && !events.some(event => event.eventKey === message.mediaEventKey)) {
      events.push({ eventKey: message.mediaEventKey, ordinal: index + 1 });
    }
  });
  return events;
}

function isWebp(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP';
}

/**
 * Pick and load the images for one turn: the first images in event order and
 * then ordinal order, within the capability bounds. An image whose derivative
 * cannot be read (not ready, deleted, checksum mismatch) is skipped and stays
 * uninspected on its event. The derivative is the only variant ever sent.
 */
export async function prepareTurnImages(
  messages: ReadonlyArray<{ mediaEventKey?: string; mediaRefs?: MediaAttachmentRef[] }>,
  readDerivative: (attachmentId: string) => Promise<Buffer>,
  bounds: ImageRequestBounds,
): Promise<PreparedTurnMedia> {
  const events = turnMediaEvents(messages);
  const images: TurnImage[] = [];
  const maxBodyBytes = Math.min(bounds.max_body_bytes, LOCAL_IMAGE_REQUEST_BOUNDS.max_body_bytes);
  if (!bounds.image_mime_types.includes('image/webp')) return { events, images, maxBodyBytes };

  const maxImages = Math.min(bounds.max_images_per_request, LOCAL_IMAGE_REQUEST_BOUNDS.max_images_per_request);
  const maxImageBytes = Math.min(bounds.max_image_decoded_bytes, MEDIA_LIMITS.maxDerivativeBytes);
  const maxDataUrlChars = WEBP_DATA_URL_PREFIX.length + 4 * Math.ceil(maxImageBytes / 3);
  let aggregateBytes = 0;
  let aggregateDataUrlChars = 0;

  for (const event of events) {
    const message = messages[event.ordinal - 1];
    const refs = [...(message.mediaRefs ?? [])]
      .map(ref => ({ ref, ordinal: Number(EVENT_LABEL.exec(ref.label)?.[1] ?? 0) }))
      .filter(entry => entry.ordinal > 0)
      .sort((left, right) => left.ordinal - right.ordinal);
    for (const { ref, ordinal } of refs) {
      if (images.length >= maxImages) break;
      let bytes: Buffer;
      try {
        bytes = await readDerivative(ref.id);
      } catch (error) {
        const code = error instanceof MediaError ? error.code : 'storage_unavailable';
        logger.debug('SDK', 'Image derivative unavailable; it stays uninspected on its event', { code });
        continue;
      }
      const skip = (code: 'image_too_large' | 'unsupported_format') => {
        logger.debug('SDK', 'Image derivative left out of the request; it stays uninspected on its event', { code });
      };
      if (!isWebp(bytes)) { skip('unsupported_format'); continue; }
      if (bytes.length > maxImageBytes) { skip('image_too_large'); continue; }
      const dataUrl = WEBP_DATA_URL_PREFIX + bytes.toString('base64');
      if (dataUrl.length > maxDataUrlChars
        || aggregateBytes + bytes.length > bounds.max_aggregate_image_decoded_bytes
        || aggregateDataUrlChars + dataUrl.length > bounds.max_aggregate_image_data_url_bytes) {
        skip('image_too_large');
        continue;
      }
      aggregateBytes += bytes.length;
      aggregateDataUrlChars += dataUrl.length;
      images.push({
        requestLabel: `event${event.ordinal}_image${ordinal}`,
        eventOrdinal: event.ordinal,
        eventKey: event.eventKey,
        attachmentId: ref.id,
        eventLabel: ref.label,
        dataUrl,
      });
    }
  }
  return { events, images, maxBodyBytes };
}

/** Freeze what the response processor needs: labels and sources, never pixels. */
export function freezeResponseMedia(
  prepared: Pick<PreparedTurnMedia, 'events' | 'images'>,
  imagesDelivered: boolean,
  /** When given, only these request labels were actually carried by the accepted request. */
  deliveredLabels?: readonly string[],
): ResponseMediaContext {
  const images = deliveredLabels ? prepared.images.filter(image => deliveredLabels.includes(image.requestLabel)) : prepared.images;
  return Object.freeze({
    events: Object.freeze(prepared.events.map(event => Object.freeze({ ...event }))),
    images: Object.freeze(images.map(({ requestLabel, eventOrdinal, eventKey, attachmentId, eventLabel }) =>
      Object.freeze({ requestLabel, eventOrdinal, eventKey, attachmentId, eventLabel }))),
    imagesDelivered: imagesDelivered && images.length > 0,
  });
}

/** Instruction 2 of the contract, verbatim. */
export function turnImageInstruction(labels: readonly string[]): string {
  return `Images attached to this turn: ${labels.join(', ')}. Each image follows a line [image LABEL]. In each <observation> informed by an image, list the label inside <attachments><attachment>LABEL</attachment></attachments>. Use only these labels.`;
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * The final user message as the contract's ordered content array: the turn
 * string unchanged, the fixed instruction, then `[image LABEL]` + image part
 * per image in request order. No `detail` field.
 */
export function imageTurnContent(turnText: string, images: ReadonlyArray<Pick<TurnImage, 'requestLabel' | 'dataUrl'>>): ChatContentPart[] {
  const parts: ChatContentPart[] = [
    { type: 'text', text: turnText },
    { type: 'text', text: turnImageInstruction(images.map(image => image.requestLabel)) },
  ];
  for (const image of images) {
    parts.push({ type: 'text', text: `[image ${image.requestLabel}]` });
    parts.push({ type: 'image_url', image_url: { url: image.dataUrl } });
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Linkage rules (parser-outcomes.json)
// ---------------------------------------------------------------------------

export type AttachmentRejectionReason = 'invalid_label' | 'unknown_label' | 'cross_event' | 'too_many_refs';

export interface SuppliedImage {
  label: string;
  event: number;
}

export interface ObservationLinkage {
  refs: string[];
  rejected: { label: string; reason: AttachmentRejectionReason }[];
}

export interface LinkageOutcome {
  observations: ObservationLinkage[];
  unassigned: string[];
}

const MAX_EVALUATED_REFS = 4;

/**
 * Apply the frozen linkage rules to one accepted response. `attachments` is
 * the parser's raw element text list for each observation (undefined or empty
 * when the observation omitted labels). An invalid response or a skip passes
 * no observations and leaves every image unassigned.
 */
export function linkAttachmentRefs(
  observations: ReadonlyArray<{ attachments?: readonly string[] }>,
  supplied: readonly SuppliedImage[],
): LinkageOutcome {
  const eventByLabel = new Map(supplied.map(image => [image.label, image.event]));
  const suppliedEvents = new Set(supplied.map(image => image.event));
  const implicitAll = observations.length === 1
    && !(observations[0].attachments?.length)
    && suppliedEvents.size === 1;

  const linked = observations.map((observation): ObservationLinkage => {
    const elements = observation.attachments ?? [];
    if (elements.length === 0) {
      return { refs: implicitAll ? supplied.map(image => image.label) : [], rejected: [] };
    }
    const rejected: { index: number; label: string; reason: AttachmentRejectionReason }[] = [];
    const accepted: { index: number; label: string }[] = [];
    elements.forEach((label, index) => {
      if (index >= MAX_EVALUATED_REFS) rejected.push({ index, label, reason: 'too_many_refs' });
      else if (!REQUEST_LABEL.test(label)) rejected.push({ index, label, reason: 'invalid_label' });
      else if (!eventByLabel.has(label)) rejected.push({ index, label, reason: 'unknown_label' });
      else if (!accepted.some(entry => entry.label === label)) accepted.push({ index, label });
    });
    const events = new Set(accepted.map(entry => eventByLabel.get(entry.label)));
    if (events.size > 1) {
      for (const entry of accepted) rejected.push({ ...entry, reason: 'cross_event' });
      accepted.length = 0;
    }
    rejected.sort((left, right) => left.index - right.index);
    return {
      refs: accepted.map(entry => entry.label),
      rejected: rejected.map(({ label, reason }) => ({ label, reason })),
    };
  });

  const linkedLabels = new Set(linked.flatMap(observation => observation.refs));
  return {
    observations: linked,
    unassigned: supplied.map(image => image.label).filter(label => !linkedLabels.has(label)),
  };
}
