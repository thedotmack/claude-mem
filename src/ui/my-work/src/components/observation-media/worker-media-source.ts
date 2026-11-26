// The MediaSource My Work uses against a claude-mem worker: this machine's at
// 127.0.0.1:37777, or the hosted one behind the work.cmem.ai gate, which
// forwards the same same-origin paths. Every request uses MEDIA_FETCH_INIT.
import type { MediaSource } from './ObsMedia'
import {
  MEDIA_FETCH_INIT,
  MEDIA_STATUS_MAX_IDS,
  mediaDescriptorUrl,
  mediaStatusUrl,
  mediaThumbnailUrl,
  mediaViewerUrl,
  parseStatusResponse,
  type ServerMediaState,
} from './media'
import { sharedViewerOwner } from '../../live/shared-viewer-session'
import { withLocalApiTokenQuery } from '../../../../local-api-token-client'

/** Ids in chunks the status route accepts. A request's drawer strip can hold more than one call's worth. */
export function statusChunks(ids: string[]): string[][] {
  const unique = [...new Set(ids)]
  const chunks: string[][] = []
  for (let start = 0; start < unique.length; start += MEDIA_STATUS_MAX_IDS) chunks.push(unique.slice(start, start + MEDIA_STATUS_MAX_IDS))
  return chunks
}

export function createWorkerMediaSource(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): MediaSource {
  const owner = sharedViewerOwner()
  const mediaPath = (localPath: string, image = false) => {
    if (!owner) return image ? withLocalApiTokenQuery(localPath) : localPath
    const path = localPath.replace('/api/media/', '/api/work-view/media/')
    return image ? `${path}?session=${encodeURIComponent(owner)}` : path
  }
  return {
    /** Throws when any chunk fails, so the strip shows "Unavailable" and rechecks instead of guessing. */
    async status(ids) {
      const answers = await Promise.all(statusChunks(ids).map(async (chunk) => {
        const response = await fetchImpl(mediaPath(mediaStatusUrl(chunk)), MEDIA_FETCH_INIT)
        if (!response.ok) throw new Error(`status ${response.status}`)
        return parseStatusResponse(await response.json(), chunk)
      }))
      return new Map<string, ServerMediaState>(answers.flatMap((answer) => [...answer]))
    },
    // An <img> cannot send the local API token header (#5141), so these carry ?token= when the page has one.
    thumbnailUrl: (id) => mediaPath(mediaThumbnailUrl(id), true),
    imageUrl: (id) => mediaPath(mediaViewerUrl(id), true),
    async descriptor(id) {
      const response = await fetchImpl(mediaPath(mediaDescriptorUrl(id)), MEDIA_FETCH_INIT)
      if (!response.ok) throw new Error(`descriptor ${response.status}`)
      return response.json()
    },
  }
}

export const workerMediaSource: MediaSource = createWorkerMediaSource()
