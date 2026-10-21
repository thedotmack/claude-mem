// The one pure mapper from a WorkViewSnapshot (local worker today, cmem.ai later) to the WorkModel the screens use.
// It follows the plan's mapping table. Where the snapshot has no value, the field takes the table's "missing" value;
// nothing is estimated or made up (spec §12). Relative imports with .ts extensions so `node --test` can load it.
import { assertConsistentRequest, type Agent, type AgentTool, type Device, type Request } from '../data.ts'
import { normalizeRequestStatus, presentStatus, STALE_AFTER_MS, type NormalizedStatus } from './status-normalization.ts'
import type { MappedWorkModel, RequestReadError } from './work-data-source.ts'
import type { WorkViewAgent, WorkViewHumanRequest, WorkViewSnapshot } from './work-view-api-types.ts'

export const THIS_COMPUTER: Device = { id: 'this-computer', name: 'This computer', syncedMinutesAgo: 0, online: true }
/** Stands in when a request names no agent the snapshot knows: the card then names the machine (§13.2). */
const UNRECORDED_AGENT: Agent = { id: 'agent-not-recorded', tool: 'other', name: 'Agent not recorded', role: 'Recorded work', deviceId: THIS_COMPUTER.id }
/** In solo mode every human request comes from the owner's own prompts. */
const SOLO_REQUESTER = 'You'
const NEXT_STEP_NOT_RECORDED = 'Next step not recorded'
const KNOWN_TOOLS: AgentTool[] = ['claude', 'codex', 'gemini']
const PLATFORM_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' }
const EVIDENCE_URL = /^\/api\/work-view\/evidence\/(work-state|observation|prompt|summary|session)\/\d+$/
const EVIDENCE_KIND_LABEL: Record<string, string> = { 'work-state': 'Work state', observation: 'Observation', prompt: 'Your prompt', summary: 'Session summary', session: 'Session' }

// cleanText is copied from claude-mem v15.0.1 plugin/ui/work-view/view-model.js:6-20: it drops injected
// instructions, code fences, markup and markdown from recorded text, then shortens at a word boundary.
const meaningful = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/^(true|false|null|undefined|\d+)$/i.test(value.trim())
export function cleanText(value: unknown, max = 150): string {
  if (!meaningful(value)) return ''
  const text = value
    .replace(/<(environment_context|instructions|system-reminder|INSTRUCTIONS|AGENTS)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
    .replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim()
  if (/^(?:AGENTS\.md instructions|You are (?:Codex|an AI)|[/{]["']?\w+["']?\s*:)/i.test(text)) return ''
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const boundary = cut.lastIndexOf(' ')
  return `${cut.slice(0, boundary > max * 0.65 ? boundary : max - 1).replace(/[,:;\-\s]+$/, '')}…`
}

const lowercaseMeridiem = (text: string) => text.replace(/\s?(AM|PM)$/, (_, meridiem: string) => ` ${meridiem.toLowerCase()}`)
/** "Oct 20, 1:16 pm", like the fixtures. */
const formatDateTime = (epoch: number) => lowercaseMeridiem(new Date(epoch).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
/** "1:56 pm" today, "Oct 19" before. */
function formatRecordTime(epoch: number, now: number) {
  const sameDay = new Date(epoch).toDateString() === new Date(now).toDateString()
  return sameDay ? lowercaseMeridiem(new Date(epoch).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })) : new Date(epoch).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
/** "10-20 13:24", the prompt-quote stamp the fixtures use. */
function formatPromptStamp(epoch: number) {
  const date = new Date(epoch)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}
function formatDuration(milliseconds: number) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000))
  if (minutes < 1) return 'Just started'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

const lastPathSegment = (path: string | null) => path?.split('/').filter(Boolean).at(-1) ?? null
/** Conversation and agent keys are JSON arrays: ["conversation", "<platform>", "<session uuid>"]. */
function parseRecordKey(key: string): string[] {
  const parsed: unknown = JSON.parse(key)
  if (!Array.isArray(parsed)) throw new Error(`Record key is not an array: ${key}`)
  return parsed.map(String)
}

export function toAgent(agent: WorkViewAgent): Agent {
  const tool = KNOWN_TOOLS.includes(agent.platformSource as AgentTool) ? agent.platformSource as AgentTool : 'other'
  return { id: agent.id, tool, name: agent.label, role: agent.sessionTitle ?? lastPathSegment(agent.project) ?? 'Recorded session', deviceId: THIS_COMPUTER.id }
}

function nextTextFor(status: NormalizedStatus, recordedNext: string) {
  if (status === 'checked') return 'Ship it'
  if (status === 'blocked') return `Unblock: ${recordedNext}`
  return recordedNext
}

/** One human request → one Request. Throws when the result breaks the lifecycle rules; the caller turns that into a read-error card. */
export function toRequest(raw: WorkViewHumanRequest, agents: WorkViewAgent[], now: number): Request {
  const copy = raw.humanCopy
  const copyReady = !!copy && ['current', 'outdated'].includes(copy.state)
  const updatedAt = raw.updatedAtEpoch ?? Math.max(0, ...raw.items.map((item) => item.lastUpdateEpoch || 0))
  const status = normalizeRequestStatus({ items: raw.items, lifecycle: raw.lifecycle, checked: raw.review?.checked === true }, now)
  const { state, stage, who } = presentStatus(status, now - updatedAt <= STALE_AFTER_MS)
  const recordedNext = (copyReady && cleanText(copy.next, 240))
    || cleanText(raw.items.find((item) => item.nextStep?.text)?.nextStep?.text, 140)
    || NEXT_STEP_NOT_RECORDED
  const agentId = agents.some((agent) => agent.id === raw.agentIds[0]) ? raw.agentIds[0] : UNRECORDED_AGENT.id
  const started = raw.startedAtEpoch
  const evidence = [
    ...(raw.original.url ? [{ title: `${EVIDENCE_KIND_LABEL.prompt}: ${cleanText(raw.original.text, 80)}`, href: raw.original.url }] : []),
    ...raw.items.map((item) => ({ title: `${EVIDENCE_KIND_LABEL[item.url.split('/')[4]] ?? 'Record'}: ${cleanText(item.title, 80)}`, href: item.url })),
  ].filter((source, index, all) => EVIDENCE_URL.test(source.href) && all.findIndex((other) => other.href === source.href) === index)

  return assertConsistentRequest({
    id: raw.id,
    contentFingerprint: raw.contentFingerprint,
    title: copyReady && copy.title?.trim() ? copy.title.trim() : null,
    summary: copyReady && copy.summary?.trim() ? copy.summary.trim() : null,
    stageNote: copy?.stage?.trim() || undefined,
    // Goal links arrive with request-progress (plan Phase 9). Until then: "Goal not linked yet".
    goalId: undefined,
    askedBy: raw.requestedBy ?? SOLO_REQUESTER,
    agentId,
    startedAt: started ? formatDateTime(started) : 'Start not recorded',
    startedAtIso: started ? new Date(started).toISOString() : undefined,
    runningFor: started ? formatDuration((raw.completedAtEpoch ?? now) - started) : 'Not recorded',
    stage,
    state,
    closed: status === 'closed' || undefined,
    // No memory review in this snapshot: no percent, no readings. An explicit shipped lifecycle is complete by definition.
    progress: {
      percent: status === 'shipped' ? 100 : null,
      readings: 0,
      reviewedAt: 'Not reviewed yet',
      history: [],
      completedAt: status === 'shipped' && raw.completedAtEpoch ? formatDateTime(raw.completedAtEpoch) : undefined,
    },
    estimate: null,
    next: { who, text: nextTextFor(status, recordedNext) },
    terminal: raw.activity.slice(0, 4).reverse().map((activity) => cleanText(`${activity.kind} ${activity.title}${activity.detail ? `: ${activity.detail}` : ''}`, 160)).filter(Boolean),
    activityWord: copyReady ? 'Working' : 'Translating',
    workstreams: raw.workstreams.map((stream) => ({
      title: cleanText(copy?.workstreams?.find((entry) => entry.id === stream.id)?.title, 115) || 'Supporting work',
      tasks: stream.items.filter((item) => item.kind === 'work-state').map((item) => ({ name: cleanText(item.title, 160) || 'Untitled task', done: ['done', 'completed'].includes(item.status) })),
    })),
    granular: raw.activity.map((activity) => ({
      kind: activity.kind === 'observation' ? 'memory' as const : 'work' as const,
      text: cleanText(activity.detail ? `${activity.title}: ${activity.detail}` : activity.title, 200),
      at: formatRecordTime(activity.atEpoch, now),
    })).filter((record) => record.text),
    conversations: raw.conversationKeys.map((key) => {
      const [, platform, sessionId] = parseRecordKey(key)
      const session = agents.find((agent) => agent.contentSessionId === sessionId && agent.sessionTitle)
      return {
        tool: PLATFORM_LABEL[platform] ?? 'Agent',
        at: key === raw.id && raw.original.atEpoch ? formatDateTime(raw.original.atEpoch) : 'Time not recorded',
        title: session?.sessionTitle ?? `Conversation ${sessionId.slice(0, 8)}`,
      }
    }),
    prompts: [raw.original, ...raw.scopeUpdates]
      .map((prompt) => ({ at: prompt.atEpoch ? formatPromptStamp(prompt.atEpoch) : 'Time not recorded', quote: cleanText(prompt.text, 400) }))
      .filter((prompt) => prompt.quote),
    workProduct: [],
    followUps: [],
    story: [],
    evidence,
    checkedAt: raw.review?.checked && raw.review.checkedAtEpoch ? formatDateTime(raw.review.checkedAtEpoch) : undefined,
  })
}

export function toWorkModel(snapshot: WorkViewSnapshot, now: number): MappedWorkModel {
  if (!Array.isArray(snapshot?.humanRequests) || typeof snapshot.source?.connected !== 'boolean') {
    throw new Error('The work view has no humanRequests list or no source health')
  }
  const requests: Request[] = []
  const requestReadErrors: RequestReadError[] = []
  for (const raw of snapshot.humanRequests) {
    try {
      requests.push(toRequest(raw, snapshot.agents, now))
    } catch (error) {
      requestReadErrors.push({
        requestId: raw.id,
        title: raw.humanCopy?.title?.trim() || null,
        reason: error instanceof Error ? error.message : String(error),
        evidenceHref: raw.original?.url && EVIDENCE_URL.test(raw.original.url) ? raw.original.url : null,
      })
    }
  }
  const agents = snapshot.agents.map(toAgent)
  if (requests.some((request) => request.agentId === UNRECORDED_AGENT.id)) agents.push(UNRECORDED_AGENT)
  return {
    sourceKind: 'local',
    requests,
    requestReadErrors,
    agents,
    devices: [THIS_COMPUTER],
    people: [...new Set(requests.map((request) => request.askedBy))],
    unlinkedWorkCount: Array.isArray(snapshot.unlinkedWork) ? snapshot.unlinkedWork.length : 0,
    sourceHealth: { connected: snapshot.source.connected, error: snapshot.source.error },
  }
}
