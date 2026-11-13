// How a thread's chat opens. A request carries only the tool and the session id; the link and the command are built
// here, so the compact overview stays small and no recorded text ever reaches a URL or a shell.
import type { Request } from '../data.ts'

/**
 * A link each tool's desktop app handles, and the terminal command as the fallback. Neither link is documented; both
 * were read from the app bundles (Claude.app's `resume` handler imports the CLI session, ChatGPT.app routes
 * `codex://threads/<id>`), so the command stays beside them.
 */
const CHAT_APPS: Record<string, { label: string; open: (sessionId: string) => string; resume: (sessionId: string) => string }> = {
  claude: { label: 'Claude Code', open: (sessionId) => `claude://resume?session=${sessionId}`, resume: (sessionId) => `claude --resume ${sessionId}` },
  codex: { label: 'Codex', open: (sessionId) => `codex://threads/${sessionId}`, resume: (sessionId) => `codex resume ${sessionId}` },
}
const TOOL_LABEL: Record<string, string> = { gemini: 'Gemini' }
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ChatLinks { tool: string; openHref?: string; resumeCommand?: string; transcriptHref?: string }

type Chat = NonNullable<Request['chat']>

/** A single conversation's request is named by its conversation key, `["conversation", "<platform>", "<session id>"]`. */
function chatFromRequestId(id: string): Chat | undefined {
  let key: unknown
  try { key = JSON.parse(id) } catch { return undefined }
  if (!Array.isArray(key) || key[0] !== 'conversation' || typeof key[1] !== 'string' || typeof key[2] !== 'string') return undefined
  return { platform: key[1], sessionId: key[2] }
}

/** The request's chat: the one recorded on it, else the conversation its own id names. */
export function requestChat(request: Pick<Request, 'id' | 'chat'>): Chat | undefined {
  return request.chat ?? chatFromRequestId(request.id)
}

/** True when the request's id already says this, so the mapper leaves `chat` off and the overview stays small. */
export function chatIsImplied(requestId: string, chat: Chat): boolean {
  const implied = chatFromRequestId(requestId)
  return !!implied && implied.platform === chat.platform && implied.sessionId === chat.sessionId && chat.transcriptHref === undefined
}

export function chatLinks(chat: Chat): ChatLinks {
  const app = chat.sessionId && SESSION_UUID.test(chat.sessionId) ? CHAT_APPS[chat.platform] : undefined
  return {
    tool: CHAT_APPS[chat.platform]?.label ?? TOOL_LABEL[chat.platform] ?? 'Agent',
    ...(app && chat.sessionId ? { openHref: app.open(chat.sessionId), resumeCommand: app.resume(chat.sessionId) } : {}),
    ...(chat.transcriptHref !== undefined ? { transcriptHref: chat.transcriptHref } : {}),
  }
}

/** Where the chat opens: in its tool when that tool has a link for the session, else the recorded transcript. */
export function chatHref(chat: Chat | undefined): string | undefined {
  if (!chat) return undefined
  const links = chatLinks(chat)
  return links.openHref ?? links.transcriptHref
}
