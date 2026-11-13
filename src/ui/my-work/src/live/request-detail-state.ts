import type { Request } from '../data.ts'

/**
 * Current card/status fields win, while a complete detail keeps the evidence omitted from its overview. A detail read
 * for an older version keeps that version's fingerprint and review: a check saved from the drawer then names the
 * evidence on screen, and the worker refuses it because the work has moved on.
 */
export function mergeRequestDetail(summary: Request, detail: Request): Request {
  return {
    ...detail,
    ...summary,
    ...(detail.contentFingerprint === summary.contentFingerprint ? {} : { contentFingerprint: detail.contentFingerprint, review: detail.review }),
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
