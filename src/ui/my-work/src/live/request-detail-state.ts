import type { Request } from '../data.ts'

/** Current card/status fields win, while a complete detail keeps the evidence omitted from its overview. */
export function mergeRequestDetail(summary: Request, detail: Request): Request {
  return {
    ...detail,
    ...summary,
    terminal: detail.terminal,
    workstreams: detail.workstreams,
    granular: detail.granular,
    conversations: detail.conversations,
    prompts: detail.prompts,
    workProduct: detail.workProduct,
    story: detail.story,
    storyNarrative: detail.storyNarrative,
    evidence: detail.evidence,
    detailLoaded: true,
  }
}

export function requestDetailKey(request: Request): string {
  return JSON.stringify([request.id, request.detailRevision ?? request.contentFingerprint ?? ''])
}

/** One read of a request's detail: the `requestDetailKey` of the version it asked for, then the detail or why it failed. */
export type RequestDetailRead = { key: string; request?: Request; error?: string }

/**
 * Which detail the open drawer shows: the current version's once its read brings it back, and until then the last
 * detail read of the same request. A new captured prompt or observation gives the request a newer version, so the
 * older detail stays on screen while that one loads, and the drawer stays as the owner left it (open sections, typed
 * words, conversation boxes). If the newer version's read fails, the older detail stays and the failure comes with
 * it, to be shown with "Try again". Null on the first read of a request, and when the last detail read belongs to a
 * different request: the drawer then shows its loading or failure page.
 */
export function requestDetailToShow(
  openRequestId: string,
  currentVersionRead: RequestDetailRead | null,
  lastReadWithDetail: RequestDetailRead | null,
): { request: Request; newerVersionReadFailure?: string } | null {
  const newestDetail = currentVersionRead?.request ?? lastReadWithDetail?.request
  if (!newestDetail || newestDetail.id !== openRequestId) return null
  if (currentVersionRead?.error === undefined) return { request: newestDetail }
  return { request: newestDetail, newerVersionReadFailure: currentVersionRead.error }
}

/**
 * The request the drawer draws while requestDetailToShow keeps an older detail on screen: the card's current status
 * over that detail's evidence (mergeRequestDetail), with that detail's content fingerprint. The fingerprint is the
 * version the review actions (Mark checked, Keep unchecked, Undo) ask the worker to check, and the worker refuses any
 * version but the current one. The records, deliverables and conversations on screen are the older version's, so a
 * check names that version and the worker refuses it ("This work changed. Read the latest result before checking it.")
 * instead of checking a newer version the owner is not looking at. A newer version whose recorded content is the same
 * (new generated copy or progress only) has the same fingerprint, so checking it still saves. The review hash stays the
 * card's: it names the review decisions the check box shows, and the box shows the card's.
 */
export function requestOnScreen(summary: Request, detailOnScreen: Request): Request {
  return { ...mergeRequestDetail(summary, detailOnScreen), contentFingerprint: detailOnScreen.contentFingerprint }
}
