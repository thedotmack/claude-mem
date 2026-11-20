import type { Request } from '../data.ts'

type Suggestion = NonNullable<Request['suggestion']>

/** The same "may be part of" suggestion: the conversation it is about, the request it points to, and its version. */
const sameSuggestion = (a: Suggestion, b: Suggestion) =>
  a.conversationKey === b.conversationKey && a.requestId === b.requestId && (a.expectedSuggestionHash ?? null) === (b.expectedSuggestionHash ?? null)

/**
 * The suggestion the drawer shows: the card's, which says whether one is still open (an answered one leaves the
 * overview while its request's detail version stays the same, so an older detail can still hold it), with the judge's
 * score from the detail when it is the same suggestion. The overview leaves the score out of its cards
 * (src/services/work-view/overview.ts cardSuggestion); only the drawer words it.
 */
function suggestionOnScreen(summary: Request['suggestion'], detail: Request['suggestion']): Request['suggestion'] {
  if (!summary || !detail || detail.confidence === undefined || !sameSuggestion(summary, detail)) return summary
  return { ...summary, confidence: detail.confidence }
}

/**
 * Current card/status fields win, while a complete detail keeps the evidence omitted from its overview. The detail's
 * own suggestion never outlives the card's (suggestionOnScreen).
 */
export function mergeRequestDetail(summary: Request, detail: Request): Request {
  const { suggestion: _detailSuggestion, ...detailWithoutSuggestion } = detail
  const suggestion = suggestionOnScreen(summary.suggestion, detail.suggestion)
  return {
    ...detailWithoutSuggestion,
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
    ...(suggestion ? { suggestion } : {}),
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
