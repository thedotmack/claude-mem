import { REVIEW_STACK_IMAGE_BYTES } from '../../../../shared/review-stack.ts'

export async function reviewStackThumbnail(file: File): Promise<string> {
  if (/^image\/(png|jpeg|webp)$/i.test(file.type) && file.size <= REVIEW_STACK_IMAGE_BYTES) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
      reader.readAsDataURL(file)
    })
  }
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error(`Could not open the image ${file.name}.`) })
  try {
    const canvas = document.createElement('canvas')
    let scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height))
    for (;;) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error(`Could not make a preview for ${file.name}.`)
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const url = canvas.toDataURL('image/webp', 0.82)
      if (url.startsWith('data:image/') && (url.length - url.indexOf(',') - 1) * 0.75 <= REVIEW_STACK_IMAGE_BYTES) return url
      if (Math.max(canvas.width, canvas.height) <= 32) throw new Error(`Choose a smaller thumbnail for ${file.name}.`)
      scale *= 0.7
    }
  } finally { bitmap.close() }
}
