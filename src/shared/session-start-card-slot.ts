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
 *
 * On a Team or Enterprise account the organization's plugin runs first and
 * sends `classic.SessionStart` past every other plugin's hooks module, so the
 * key is never added (#6314). `session.start` still reaches the card there,
 * when the Claude Code process starts. So the card also asks with a request
 * file in the slot folder. The context hook, seeing no key and a request of
 * its session that has not run out, names the slot itself, and the card looks
 * for that slot until the request runs out. The card writes its request while
 * the hook runs, so a hook that finds none yet waits a bounded time for it
 * (awaitSessionStartCardSlotForRequest, src/cli/session-start-card-slot-writer.ts).
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

/**
 * The clock in a slot file's name when the file is a slot of `sessionId`, or
 * null. The clock is a whole number of milliseconds: a row id made from it
 * matches what `$.ui.place` takes.
 */
export function sessionStartCardSlotClockOf(fileName: string, sessionId: string): number | null {
  if (!isSessionStartCardSlotFileNameOf(fileName, sessionId)) return null;
  const clockEpochMs = Number(fileName.slice(sessionId.length + 1, -'.json'.length));
  return Number.isSafeInteger(clockEpochMs) ? clockEpochMs : null;
}

/**
 * How often the card looks for the slot it asked for with a request file.
 * Each look is one listing of the slot folder, which holds the slots of the
 * last hour. Measured for #6314 (Claude Code 2.1.326, macOS, a Team account):
 * the slot was there 0.3 s after `session.start` ran. At this rate the second
 * look finds such a slot, and a slot is found one look after it is written at
 * the latest.
 */
export const SESSION_START_CARD_REQUEST_LOOK_EVERY_MS = 200;

/**
 * How long a request file stands, and how long the card looks. The card reads
 * its clock at each tick of its timer, and the first tick that comes this long
 * after it asked is its last: it looks once more there, or stops at once when
 * a listing is still pending. So one start makes 40 listings at most, and its
 * timer ends by the clock, however long a listing takes. The 0.3 s measured
 * for #6314 is 1/26 of the wait. How long a context hook takes that has to
 * start the worker first was not measured. A context hook that
 * takes longer than this finds the request run out and sends the whole banner
 * as its message, so a slow start loses the card and never the banner.
 */
export const SESSION_START_CARD_REQUEST_WAIT_MS = 8_000;

/** One session's request file: `<session id>.<the card's clock when it asked, in ms>.request`. */
const REQUEST_FILE_NAME = /^[A-Za-z0-9_-]+\.\d+\.request$/;

export function isSessionStartCardRequestFileName(fileName: string): boolean {
  return REQUEST_FILE_NAME.test(fileName);
}

/** The file the card asks with: it is empty, and its name says which session asked and when. */
export function sessionStartCardRequestPath(pluginDataDirectory: string, sessionId: string, askedAtEpochMs: number): string {
  return `${pluginDataDirectory.replace(/[\\/]+$/, '')}/${SESSION_START_CARD_FOLDER}/${sessionId}.${askedAtEpochMs}.request`;
}

/** The clock in a request file's name when the file is a request of `sessionId`, or null. */
export function sessionStartCardRequestClockOf(fileName: string, sessionId: string): number | null {
  if (!isFileNameSafeSessionId(sessionId) || !fileName.startsWith(`${sessionId}.`)) return null;
  const clock = /^(\d+)\.request$/.exec(fileName.slice(sessionId.length + 1));
  if (!clock) return null;
  const askedAtEpochMs = Number(clock[1]);
  return Number.isSafeInteger(askedAtEpochMs) ? askedAtEpochMs : null;
}

/**
 * Whether the card that asked at `askedAtEpochMs` will still look for a slot
 * written at `nowEpochMs`. The card's last look comes no sooner than the wait
 * after it asked. A request is answered only up to one look before that.
 * This counts on the context hook's folder listing and file write, between this
 * check and the finished slot, taking less than one look. That was not measured.
 * It also counts on each listing of the card settling within one look. When a
 * listing is still pending the wait after the card asked, the card stops
 * there, and that listing is its last look: it can have started before the
 * slot was finished. How long a listing of the card takes was not measured.
 * A request from the future (a clock set back) is not answered.
 */
export function isSessionStartCardRequestStanding(askedAtEpochMs: number, nowEpochMs: number): boolean {
  const ageMs = nowEpochMs - askedAtEpochMs;
  return ageMs >= 0 && ageMs <= SESSION_START_CARD_REQUEST_WAIT_MS - SESSION_START_CARD_REQUEST_LOOK_EVERY_MS;
}

/**
 * The newest slot of `sessionId` among `fileNames` that was named at or after
 * `notBeforeEpochMs`, or null. A slot named before the card asked belongs to
 * an earlier start of the same session (a compaction, a plugin reload, a
 * resumed session), and its banner is not this start's.
 */
export function newestSessionStartCardSlotSince(
  fileNames: readonly string[],
  sessionId: string,
  notBeforeEpochMs: number,
): { fileName: string; clockEpochMs: number } | null {
  let newest: { fileName: string; clockEpochMs: number } | null = null;
  for (const fileName of fileNames) {
    const clockEpochMs = sessionStartCardSlotClockOf(fileName, sessionId);
    if (clockEpochMs === null || clockEpochMs < notBeforeEpochMs) continue;
    if (newest === null || clockEpochMs > newest.clockEpochMs) newest = { fileName, clockEpochMs };
  }
  return newest;
}
