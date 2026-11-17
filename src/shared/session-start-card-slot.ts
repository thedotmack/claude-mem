/**
 * The handoff between the session-start card (src/mods/session-start-card, part
 * of claude-mem's Claude Code hooks module) and the SessionStart context hook
 * (src/cli/handlers/context.ts). No Node imports: a hooks module has none.
 *
 * Claude Code shows a hook's `systemMessage` with the hook's name once in the
 * terminal, but on every line in the stream it sends to the Claude app. So
 * where the card can draw, it adds SESSION_START_CARD_FILE_KEY to the
 * SessionStart event: a file it reads once the command hooks have finished.
 * The context hook, seeing the key, writes the terminal banner there and sends
 * a one-line `systemMessage` in its place. Without the key (an older Claude
 * Code, another host, a session with no terminal) nothing changes.
 */

/** The key the card adds to the SessionStart event; the command hooks get it on stdin. */
export const SESSION_START_CARD_FILE_KEY = 'claude_mem_session_start_card_file';

/** The folder, inside the plugin's data folder (CLAUDE_PLUGIN_DATA), that holds the slot files. */
export const SESSION_START_CARD_FOLDER = 'session-start-card';

/**
 * The SessionStart sources the context hook runs on (its matcher in
 * plugin/hooks/hooks.json), so the only ones a card can follow.
 */
export const SESSION_START_CARD_SOURCES = ['startup', 'clear', 'compact'] as const;

/** What the context hook writes into a slot: the banner, colored with the renderer's SGR codes. */
export interface SessionStartCardSlot {
  text: string;
}

/** A session id that can sit in a file name as it is. Claude Code's are UUIDs. */
const FILE_NAME_SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;
/** Any session's slot file: `<session id>.<the card's clock at that start, in ms>.json`. */
const SLOT_FILE_NAME = /^[A-Za-z0-9_-]+\.\d+\.json$/;

export function isFileNameSafeSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && FILE_NAME_SAFE_SESSION_ID.test(sessionId);
}

export function isSessionStartCardSlotFileName(fileName: string): boolean {
  return SLOT_FILE_NAME.test(fileName);
}

/** Whether `fileName` is a slot of `sessionId`, so one session cannot name another's file. */
export function isSessionStartCardSlotFileNameOf(fileName: string, sessionId: string): boolean {
  return isFileNameSafeSessionId(sessionId)
    && isSessionStartCardSlotFileName(fileName)
    && fileName.startsWith(`${sessionId}.`)
    && /^\d+\.json$/.test(fileName.slice(sessionId.length + 1));
}

/**
 * One file per session start, named by the session and the card's clock at
 * that start, so a start never reads the banner of an earlier one.
 */
export function sessionStartCardSlotPath(pluginDataDirectory: string, sessionId: string, startedAtEpochMs: number): string {
  return `${pluginDataDirectory.replace(/[\\/]+$/, '')}/${SESSION_START_CARD_FOLDER}/${sessionId}.${startedAtEpochMs}.json`;
}
