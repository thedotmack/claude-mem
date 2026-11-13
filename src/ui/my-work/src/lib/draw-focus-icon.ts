// Draws a picked image file as a focus icon: centre-cropped to a square, exported as WebP (PNG where the browser
// cannot encode WebP). A picked SVG is drawn like any other image, so it is never stored as SVG.
import type { FocusIconUpload } from '@/data'
import { centerCrop, FOCUS_ICON_SIDES, focusIconUpload } from '@/live/focus-icon'

export const CANNOT_READ_IMAGE = 'This file could not be read as an image.'

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(CANNOT_READ_IMAGE)) }
    image.src = url
  })
}

export async function drawFocusIcon(file: Blob): Promise<FocusIconUpload> {
  const image = await loadImage(file)
  // An SVG with no size of its own reports none; it is drawn across the whole square.
  const crop = image.naturalWidth && image.naturalHeight ? centerCrop(image.naturalWidth, image.naturalHeight) : null
  for (const side of FOCUS_ICON_SIDES) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = side
    const context = canvas.getContext('2d')
    if (!context) break
    if (crop) context.drawImage(image, crop.x, crop.y, crop.side, crop.side, 0, 0, side, side)
    else context.drawImage(image, 0, 0, side, side)
    const upload = focusIconUpload(canvas.toDataURL('image/webp', 0.9))
    if (upload) return upload
  }
  throw new Error(CANNOT_READ_IMAGE)
}
