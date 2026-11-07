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
