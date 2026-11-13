// What a request's Stage cell offers on its row, and what opening a ready stage shows. A stage is a document the
// owner's agent wrote for a finished review (services/work-view/stage-task.ts); the page reads it in place.
import type { Request, RequestStage, StageFormatInfo } from '../data.ts'

type WorkProduct = Request['workProduct'][number]

/**
 * Where the row's stage stands, for the one format the cell is about. `none` offers to generate it; nothing is made
 * until that click.
 *
 *   none ──Generate──▶ making ──▶ ready
 *                         └─────▶ failed ──Generate──▶ making
 *
 * The worker's owner-run store is the one writer (owner-runs.mjs STAGE_STATES); this is how a row words it.
 */
export type StageOffer =
  | { kind: 'ready'; formatId: string; label: string }
  | { kind: 'making'; formatId: string; label: string }
  | { kind: 'failed'; formatId: string; label: string; error: string | null }
  | { kind: 'none'; formatId: string; label: string }

export interface StageCell {
  /** Null when the worker lists no stage format: there is nothing to make or read. */
  stage: StageOffer | null
  /** What the agent made, when the review has a deliverable and no ready stage stands in for it. */
  product: WorkProduct | null
}

/**
 * The cell for a row that waits for a review. A ready stage wins (the first format listed that has one), then one
 * being made, then a failed one; with none, the default format is offered: the one automatic stages use, else the
 * first the worker lists (the brief). The row knows the stage list only once the request's detail was read
 * (`stages`); before that it knows which formats are ready (`readyStages`).
 */
export function stageCell(request: Pick<Request, 'readyStages' | 'stages' | 'workProduct'>, formats: readonly StageFormatInfo[], autoFormat?: string | null): StageCell {
  const product = request.workProduct[0] ?? null
  const label = (formatId: string) => formats.find((format) => format.id === formatId)?.label ?? formatId
  const stateOf = (formatId: string): RequestStage['state'] | null =>
    request.stages?.find((stage) => stage.formatId === formatId)?.state ?? (request.readyStages?.includes(formatId) ? 'ready' : null)
  const listed = [...formats.map((format) => format.id), ...(request.readyStages ?? []), ...(request.stages ?? []).map((stage) => stage.formatId)]
  const first = (state: RequestStage['state']) => listed.find((formatId) => stateOf(formatId) === state)
  const ready = first('ready')
  if (ready) return { stage: { kind: 'ready', formatId: ready, label: label(ready) }, product: null }
  const making = first('generating')
  if (making) return { stage: { kind: 'making', formatId: making, label: label(making) }, product }
  const failed = first('failed')
  if (failed) return { stage: { kind: 'failed', formatId: failed, label: label(failed), error: request.stages?.find((stage) => stage.formatId === failed)?.error ?? null }, product }
  const fallback = formats.find((format) => format.id === autoFormat) ?? formats[0]
  return { stage: fallback ? { kind: 'none', formatId: fallback.id, label: fallback.label } : null, product }
}

/** How a stage's file is shown: Markdown as a document the page lays out, HTML in a frame that can reach nothing. */
export type StageReading = { formatId: string; label: string; href: string; output: StageFormatInfo['output']; newTabHref: string | null; outdated: boolean }

/**
 * What a ready stage opens: the reader, with the file's address and how to show it. Null when the stage is not
 * ready, has no file, or its format is not one the worker lists (its output kind is then unknown, and an unknown
 * document is not rendered on a guess). A sample stage's text rides in its address (`data:`), which no tab can open.
 */
export function stageReading(stage: Pick<RequestStage, 'formatId' | 'state' | 'href' | 'outdated'> | undefined, formats: readonly StageFormatInfo[]): StageReading | null {
  const format = formats.find((entry) => entry.id === stage?.formatId)
  if (!stage || !format || stage.state !== 'ready' || !stage.href || stage.href === '#') return null
  return { formatId: format.id, label: format.label, href: stage.href, output: format.output, newTabHref: stage.href.startsWith('data:') ? null : stage.href, outdated: stage.outdated }
}

/** The version of the request the reader's document was opened on, and whether that stage was already behind it. */
export type StageRead = { fingerprint: string | undefined; reviewHash: string | null | undefined; outdated: boolean }

/**
 * What the reader does about "Mark checked". A check certifies a version, and here the owner read a stage, so the
 * check is for the version the stage was opened on and for no other.
 *
 *   none      the request does not wait for a check, or nothing was read yet
 *   outdated  the stage was written before the request's current work: reading it is not a review of that work
 *   changed   the request moved on while the stage was open: what is on screen was never read
 *   offer     the request is still the version the stage was opened on
 */
export type ReaderCheck = 'none' | 'outdated' | 'changed' | 'offer'

export function readerCheck(read: Pick<StageRead, 'fingerprint' | 'outdated'> | null, current: { waitsForCheck: boolean; fingerprint: string | undefined }): ReaderCheck {
  if (!read || !current.waitsForCheck) return 'none'
  if (read.outdated) return 'outdated'
  return read.fingerprint === current.fingerprint ? 'offer' : 'changed'
}
