import type { Request } from '../../data'
import type { VMedia } from './media'

/**
 * Every image the drawer's records link, newest record first, each once: one turn links the same images to every
 * observation it stored. This is the set request.media.count counts (request-projection.mjs requestMediaSummary).
 */
export function requestImages(request: Pick<Request, 'granular'>): VMedia | undefined {
  const seen = new Set<string>()
  const attachments = request.granular.flatMap((record) => record.media?.attachments ?? []).filter((ref) => !seen.has(ref.id) && !!seen.add(ref.id))
  return attachments.length > 0 ? { version: 1, attachments } : undefined
}
