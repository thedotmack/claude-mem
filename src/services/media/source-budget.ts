import { MediaError } from '../../shared/media-contract.js';

/**
 * A worker-wide budget for the image file bytes capture holds in memory at
 * once. A caller reserves its file's size before reading the file and
 * releases it once the capture ends, so captures waiting for the conversion
 * slot never pile up file buffers. Callers that do not fit wait, first come
 * first served, holding no image bytes; nothing fails for waiting. Every
 * holder releases when its capture ends (the converter's admission wait and
 * deadline bound that), so the queue always moves.
 */
export function createSourceByteBudget(capacityBytes: number) {
  let heldBytes = 0;
  const waiting: Array<{ bytes: number; admit: () => void }> = [];
  const releaseFor = (bytes: number) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      heldBytes -= bytes;
      while (waiting.length > 0 && heldBytes + waiting[0]!.bytes <= capacityBytes) {
        const next = waiting.shift()!;
        heldBytes += next.bytes;
        next.admit();
      }
    };
  };
  return {
    get heldBytes() { return heldBytes; },
    get waitingCount() { return waiting.length; },
    /** Resolves with a release function once `bytes` fit the budget. */
    async reserve(bytes: number): Promise<() => void> {
      if (!Number.isInteger(bytes) || bytes < 0 || bytes > capacityBytes) throw new MediaError('source_too_large');
      if (waiting.length === 0 && heldBytes + bytes <= capacityBytes) {
        heldBytes += bytes;
        return releaseFor(bytes);
      }
      await new Promise<void>(admit => { waiting.push({ bytes, admit }); });
      return releaseFor(bytes);
    },
  };
}
