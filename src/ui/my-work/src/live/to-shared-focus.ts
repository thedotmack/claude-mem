// One focus area as a shared page (cmem.ai/focus/<token>): what the owner sees in its header and cards, cut to what
// can leave this computer. The worker runs it on its own work view (src/services/work-view/focus-share-publisher.ts),
// so it stays pure and imports with .ts extensions. The shape is claude-mem-pro's src/lib/focus-share/snapshot.ts;
// keep the two in step.
//
// What it shows stays relevant to the people it is shared with (R17.3): only requests placed in this area, so a new
// request shows up when it lands here and nothing from other areas or Other ever does. Moving a request out of the
// area takes it off the page. Closed requests stay off, as they do on My Work. The owner's own words (quotes,
// prompts, and any title, ask or goal that repeats them), terminal lines, evidence links, work product,
// conversations and machine names never leave.
import { OTHER_FOCUS_AREA_ID, type FocusArea, type Request } from '../data.ts'
import { repeatsOwnerWords } from './prompt-echo.ts'
import { resolveFocusAreaId } from './to-focus-model.ts'
import type { WorkModel } from './work-data-source.ts'

export const SHARED_REQUESTS_MAX = 200
export const SHARED_ASKS_MAX = 50

export interface SharedRequest {
  id: string
  title: string
  summary: string | null
  state: Request['state']
  stage: string
  percent: number | null
  next: { who: 'bot' | 'human'; text: string }
  agent: string
  startedAt: string
  runningFor: string
  completedAt: string | null
}

export interface SharedFocusPage {
  version: 1
  area: {
    id: string
    name: string
    goal: string | null
    done: boolean
    shipped: number
    progress: { percent: number | null; reviewed: number; total: number }
  }
  requests: SharedRequest[]
  notStarted: { id: string; title: string; timesAsked: number; latestAt: string | null }[]
  generatedAt: string
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const UNTITLED = 'New request, title being written'
/** In place of text that repeats the owner's own words (prompt-echo.ts), which stay on this computer. */
const PRIVATE_TITLE = 'Untitled request'
const PRIVATE_ASK = 'Untitled ask'

/** Whether a title repeats the request's own prompts as the card quotes them. */
export function titleQuotesPrompt(title: string, prompts: readonly { quote: string }[]): boolean {
  return repeatsOwnerWords(title, prompts.map((prompt) => prompt.quote))
}

function sharedTitle(request: Request): string {
  const title = request.title?.trim()
  if (!title) return UNTITLED
  return request.titleRepeatsPrompt || titleQuotesPrompt(title, request.prompts) ? PRIVATE_TITLE : title
}

const ownWords = (area: FocusArea) => [...area.quotes, ...area.asks.flatMap((ask) => ask.quotes)].map((quote) => quote.quote)

/** The requests in an area, as My Work lists them when the area is selected. */
export function requestsInArea(model: Pick<WorkModel, 'requests' | 'focusAreas'>, focusAreaId: string): Request[] {
  return model.requests.filter((request) => resolveFocusAreaId(request.focusAreaId, model.focusAreas) === focusAreaId)
}

/** Whether an area can be shared: a live area the owner sees, not Other, a suggestion or a merged-away one. */
export function canShareArea(area: FocusArea | undefined): area is FocusArea {
  return !!area && area.id !== OTHER_FOCUS_AREA_ID && !area.mergedInto && (area.status === 'kept' || area.status === 'done')
}

/** The shared page for one area. Null when the area cannot be shared (see canShareArea). */
export function toSharedFocusPage(model: Pick<WorkModel, 'requests' | 'focusAreas' | 'agents'>, focusAreaId: string, now: number): SharedFocusPage | null {
  const area = model.focusAreas.find((entry) => entry.id === focusAreaId)
  if (!canShareArea(area)) return null
  const all = requestsInArea(model, focusAreaId)
  // The area header's rollup (focus-header.tsx Rollup): reviewed requests only, closed ones included.
  const reviewed = all.filter((request) => request.progress.readings > 0)
  const percent = reviewed.length ? Math.round(reviewed.reduce((sum, request) => sum + (request.progress.percent ?? 0), 0) / reviewed.length) : null
  const open = all.filter((request) => !request.closed)
  const agentName = (request: Request) => model.agents.find((agent) => agent.id === request.agentId)?.name ?? 'Agent not recorded'
  return {
    version: 1,
    area: {
      id: area.id,
      name: clip(area.name, 120),
      goal: area.goal && !repeatsOwnerWords(area.goal, ownWords(area)) ? clip(area.goal, 500) : null,
      done: area.status === 'done',
      shipped: all.filter((request) => request.state === 'shipped').length,
      progress: { percent, reviewed: reviewed.length, total: all.length },
    },
    requests: open.slice(0, SHARED_REQUESTS_MAX).map((request) => ({
      id: request.id,
      title: clip(sharedTitle(request), 200),
      summary: request.summary?.trim() ? clip(request.summary.trim(), 600) : null,
      state: request.state,
      stage: request.stage,
      percent: request.progress.percent,
      next: { who: request.next.who, text: clip(request.next.text.trim() || 'Next step not recorded', 300) },
      agent: clip(agentName(request), 80),
      startedAt: clip(request.startedAt, 60),
      runningFor: clip(request.runningFor, 60),
      completedAt: request.progress.completedAt ? clip(request.progress.completedAt, 60) : null,
    })),
    notStarted: area.asks.slice(0, SHARED_ASKS_MAX).map((ask) => ({ id: ask.id, title: clip(repeatsOwnerWords(ask.title, ask.quotes.map((quote) => quote.quote)) ? PRIVATE_ASK : ask.title, 200), timesAsked: ask.timesAsked, latestAt: ask.latestAt || null })),
    generatedAt: new Date(now).toISOString(),
  }
}
