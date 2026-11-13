// A focus area's own icon: where the page reads it from, and how a picked image becomes the small square the worker
// stores. Pure, so `node --test` can load it; the drawing itself (a canvas) is in lib/draw-focus-icon.ts.
import type { FocusArea, FocusIconUpload } from '../data.ts'
import { FOCUS_ICON_UPLOAD_FORMATS, MAX_FOCUS_ICON_DIRECTION_CHARS, MAX_FOCUS_ICON_UPLOAD_BYTES } from '../../../../services/work-view/focus-icon-limits.mjs'

/** The sides an upload is drawn at, largest first: a smaller one is tried only when the larger is over the worker's limit. */
export const FOCUS_ICON_SIDES = [256, 192, 128] as const
/** What the file picker offers. Whatever is picked is redrawn, so the worker only ever stores a WebP or a PNG. */
export const FOCUS_ICON_PICKABLE = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml'

/** The `<img src>` of an area's icon, or null when it has none. The version in the URL lets the browser keep it for good. */
export function focusIconSrc(area: Pick<FocusArea, 'id' | 'icon'>): string | null {
  if (!area.icon) return null
  return area.icon.startsWith('data:') ? area.icon : `/api/work-view/focus-icon/${encodeURIComponent(area.id)}?v=${encodeURIComponent(area.icon)}`
}

/** What the icon menu on a focus line offers. One definition; the menu's words are a table over it. */
export const FOCUS_ICON_ACTIONS = ['upload', 'generate', 'generate-with-prompt', 'remove'] as const
export type FocusIconAction = (typeof FOCUS_ICON_ACTIONS)[number]

/**
 * The menu for one focus, in order. Remove is offered only when there is an icon to remove. While one is being drawn
 * neither Generate starts another; an upload or a removal still stands over the run's answer.
 */
export function focusIconMenu(area: Pick<FocusArea, 'icon' | 'iconRun'>): { action: FocusIconAction; disabled: boolean }[] {
  const generating = area.iconRun?.state === 'generating'
  return FOCUS_ICON_ACTIONS.filter((action) => action !== 'remove' || Boolean(area.icon))
    .map((action) => ({ action, disabled: generating && (action === 'generate' || action === 'generate-with-prompt') }))
}

/** The owner's typed direction as it is sent: trimmed and within the worker's limit. Null when nothing was typed. */
export function iconDirection(typed: string): string | null {
  return typed.trim().slice(0, MAX_FOCUS_ICON_DIRECTION_CHARS).trim() || null
}

/** The largest centred square of an image, as the source rectangle of a canvas draw. */
export function centerCrop(width: number, height: number): { x: number; y: number; side: number } {
  const side = Math.min(width, height)
  return { x: (width - side) / 2, y: (height - side) / 2, side }
}

/**
 * A canvas export as the upload the worker takes. Null when the export is not a WebP or PNG (a browser that cannot
 * encode WebP answers PNG by itself), or is over the worker's size limit.
 */
export function focusIconUpload(dataUrl: string): FocusIconUpload | null {
  const match = /^data:image\/([a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  const format = FOCUS_ICON_UPLOAD_FORMATS.find((known) => known === match?.[1])
  if (!match || !format) return null
  const data = match[2]
  const bytes = Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
  return bytes > MAX_FOCUS_ICON_UPLOAD_BYTES ? null : { format, data }
}
