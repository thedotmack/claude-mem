import { REVIEW_STACK_IMPORT_LIMIT, type ReviewStackImportCard } from '../../../../shared/review-stack.ts'
import { sendReviewCards } from './review-stack-client.ts'

type ImportFile = File & { webkitRelativePath?: string }
type Thumbnail = (file: File) => Promise<string>
type ManifestCard = ReviewStackImportCard & { imageFile?: string }
export interface ReviewImport {
  cards: ManifestCard[]; files: ImportFile[]; offset: number; added: number; existing: number; batchKey: string
}

/** Validate the entire manifest's shape before sending. Relative image references can only name selected files. */
export async function readReviewManifest(files: ImportFile[]): Promise<ReviewImport> {
  const manifests = files.filter(file => /\.json$/i.test(file.name))
  if (manifests.length !== 1) throw new Error('Choose one cards.json file and the images it references.')
  let payload: { cards?: unknown }
  try { payload = JSON.parse(await manifests[0].text()) } catch { throw new Error('This file could not be read as JSON.') }
  if (!Array.isArray(payload?.cards) || !payload.cards.length) throw new Error('The manifest needs a cards array with at least one original.')
  const keys = new Set<string>()
  const cards = payload.cards.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Card ${index + 1} could not be read.`)
    for (const field of ['key', 'focus', 'title', 'what', 'context']) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) throw new Error(`Card ${index + 1} needs ${field}.`)
    }
    const { key, focus, title, what, context } = entry
    const card: ManifestCard = { key: key.trim(), focus, title, what, context }
    if (keys.has(card.key)) throw new Error(`Duplicate card key: ${card.key}`)
    keys.add(card.key)
    for (const field of ['source', 'preview', 'imageData', 'excerpt', 'imageFile'] as const) {
      if (entry[field] == null || entry[field] === '') continue
      if (typeof entry[field] !== 'string') throw new Error(`Card ${index + 1}: ${field} must be text.`)
      card[field] = entry[field]
    }
    if (card.imageFile) originalImage(card.imageFile, files)
    return card
  })
  return { cards, files, offset: 0, added: 0, existing: 0, batchKey: crypto.randomUUID() }
}

function originalImage(relative: string, files: ImportFile[]) {
  if (typeof relative !== 'string' || /(^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$))/.test(relative)) throw new Error('Choose images alongside cards.json using relative imageFile names.')
  const path = relative.replace(/\\/g, '/')
  const name = path.split('/').at(-1)
  const exact = files.filter(file => file.webkitRelativePath === path || file.webkitRelativePath?.endsWith('/' + path))
  const matches = exact.length ? exact : files.filter(file => file.name === name)
  if (matches.length !== 1) throw new Error(`Select the image ${path} with cards.json. Each image name must identify one file.`)
  return matches[0]
}

async function importCard({ imageFile, ...card }: ManifestCard, files: ImportFile[], thumbnail: Thumbnail): Promise<ReviewStackImportCard> {
  if (imageFile) card.imageData = await thumbnail(originalImage(imageFile, files))
  return card
}

/** The caller keeps this job after a failure. Its offset advances only after a receipt, so retries address the same batch. */
export async function importReviewManifest(job: ReviewImport, progress: () => void, thumbnail: Thumbnail, send = sendReviewCards) {
  while (job.offset < job.cards.length) {
    const batch = job.cards.slice(job.offset, job.offset + REVIEW_STACK_IMPORT_LIMIT)
    const cards: ReviewStackImportCard[] = []
    for (const card of batch) cards.push(await importCard(card, job.files, thumbnail))
    const result = await send(cards, job.batchKey)
    job.added += result.added; job.existing += result.existing; job.offset += batch.length
    job.batchKey = crypto.randomUUID()
    progress()
  }
}
