// Sample mode's images (`?source=sample`): no worker, no network. Copied from
// PR #265's /dev/viewer-preview `?demo=media` fixture (claude-mem-pro 3dd60b18,
// src/app/dev/viewer-preview/page.tsx), so the wireframe shows every display
// state: ready, uninspected, processing, deleted, an image whose bytes fail to
// load, and rejected. Nothing here is real.
// Imports stay in plain .ts files: the node tests load data.ts, which loads this.
import type { ServerMediaState, VMediaRef } from './media.ts'

export const SAMPLE_MEDIA_IDS = Array.from({ length: 6 }, (_, i) => `0000000${i}-aaaa-4aaa-8aaa-00000000000${i}`)
const SAMPLE_MEDIA_STATES: ServerMediaState[] = ['ready', 'ready', 'pending', 'deleted', 'ready', 'rejected']
const BROKEN_ID = SAMPLE_MEDIA_IDS[4]

export const SAMPLE_MEDIA_REFS: VMediaRef[] = SAMPLE_MEDIA_IDS.map((id, i) => ({
  id,
  label: `event1_image${(i % 4) + 1}`,
  inspection: i === 1 ? 'uninspected' : 'inspected',
}))

const svg = (hue: number, text: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="hsl(${hue} 55% 88%)"/><rect x="60" y="60" width="1080" height="80" rx="12" fill="hsl(${hue} 45% 60%)"/><text x="600" y="460" font-family="sans-serif" font-size="72" text-anchor="middle" fill="hsl(${hue} 40% 25%)">${text}</text></svg>`)}`
const sampleImage = (id: string) => (id === BROKEN_ID ? '/__missing__.webp' : svg(SAMPLE_MEDIA_IDS.indexOf(id) * 50, `Screenshot ${SAMPLE_MEDIA_IDS.indexOf(id) + 1}`))

/** A MediaSource (ObsMedia.tsx); App.tsx's provider checks the shape. */
export const SAMPLE_MEDIA_SOURCE = {
  status: async (ids: string[]) => new Map(ids.map((id): [string, ServerMediaState] => [id, SAMPLE_MEDIA_STATES[SAMPLE_MEDIA_IDS.indexOf(id)] ?? 'pending'])),
  thumbnailUrl: sampleImage,
  imageUrl: sampleImage,
  descriptor: async () => ({
    recipe: 'screenshot-v1',
    encoderVersion: 'sharp-0.34.4/vips-8.17.2',
    viewer: { width: 1200, height: 800, byteLength: 182_000 },
    llm: { width: 1200, height: 800, byteLength: 96_000 },
  }),
}
