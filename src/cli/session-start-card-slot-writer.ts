/**
 * The context hook's half of the session-start card handoff
 * (src/shared/session-start-card-slot.ts): it writes the terminal banner into
 * the file the card named, for the card to draw.
 */
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import path from 'path';
import { TERMINAL_ENTRYPOINT } from '../mods/session-start-card/card.js';
import { writeTextFileAtomic } from '../shared/atomic-json.js';
import { logger } from '../utils/logger.js';
import {
  isFileNameSafeSessionId,
  isSessionStartCardRequestFileName,
  isSessionStartCardRequestStanding,
  isSessionStartCardSlotFileName,
  isSessionStartCardSlotFileNameOf,
  SESSION_START_CARD_FOLDER,
  sessionStartCardRequestClockOf,
  sessionStartCardSlotPath,
  type SessionStartCardSlot,
} from '../shared/session-start-card-slot.js';

/**
 * A slot file this old is deleted the next time a session writes one, or a
 * hook's wait for a request runs out. So is a
 * request file of that age: a request stands for 8 seconds
 * (SESSION_START_CARD_REQUEST_WAIT_MS), so one this old is answered or run out. The
 * card reads its slot once, as soon as the SessionStart command hooks have
 * finished, and Claude Code stops a command hook after 10 minutes unless the
 * hook's own `timeout` says otherwise (claude-mem's longest at SessionStart is
 * 180 seconds, scripts/build-hooks.js). An hour is six times that default, so
 * a file deleted here was read already, or was left by a session that ended
 * before reading it. A start whose hooks run longer than this, while another
 * session starts, shows the one-line message and no card.
 */
export const SESSION_START_CARD_SLOT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * A slot holds memory text (the timeline, the last reply), and the plugin data
 * folder is outside claude-mem's own data directory, which only its owner can
 * read. So the slot folder and each slot are made owner-only too.
 */
const SLOT_FOLDER_MODE = 0o700;
const SLOT_FILE_MODE = 0o600;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pruneOldSlots(slotFolder: string, writtenFileName: string | null, nowEpochMs: number): void {
  try {
    for (const fileName of readdirSync(slotFolder)) {
      if (fileName === writtenFileName) continue;
      if (!isSessionStartCardSlotFileName(fileName) && !isSessionStartCardRequestFileName(fileName)) continue;
      const filePath = path.join(slotFolder, fileName);
      if (nowEpochMs - statSync(filePath).mtimeMs > SESSION_START_CARD_SLOT_MAX_AGE_MS) rmSync(filePath, { force: true });
    }
  } catch (error) {
    // Another session's start may be pruning the same folder; what is left goes at the next start.
    logger.debug('HOOK', 'Could not prune old session-start card files', { slotFolder, error: errorText(error) });
  }
}

/**
 * Writes `bannerText` to `slotFile` and returns whether the card can now draw
 * it. The path came in on the hook's stdin, where any plugin's hooks module
 * can put one, so it is written only when it is a slot of this session inside
 * this plugin's own data folder (CLAUDE_PLUGIN_DATA, which Claude Code sets
 * for the hook). On false the caller sends the whole banner as the hook
 * message, as it does without the card, and the card finds no file to draw.
 */
export function writeSessionStartCardSlot(
  slotFile: string,
  sessionId: string | undefined,
  bannerText: string,
  pluginDataDirectory: string | undefined = process.env.CLAUDE_PLUGIN_DATA,
  nowEpochMs: number = Date.now(),
): boolean {
  if (!pluginDataDirectory || !path.isAbsolute(pluginDataDirectory) || !sessionId) {
    logger.debug('HOOK', 'Session-start card file ignored: no plugin data folder or session id', {
      hasPluginDataDirectory: Boolean(pluginDataDirectory),
      hasSessionId: Boolean(sessionId),
    });
    return false;
  }
  const slotFolder = path.resolve(pluginDataDirectory, SESSION_START_CARD_FOLDER);
  const slotFileName = path.basename(slotFile);
  if (
    !path.isAbsolute(slotFile)
    || path.resolve(path.dirname(slotFile)) !== slotFolder
    || !isSessionStartCardSlotFileNameOf(slotFileName, sessionId)
  ) {
    logger.warn('HOOK', 'Session-start card file refused: not a slot of this session in the plugin data folder', { slotFile, slotFolder });
    return false;
  }
  try {
    mkdirSync(slotFolder, { recursive: true, mode: SLOT_FOLDER_MODE });
    // The card's request file may have made the folder first, through `$.fs.write`. The mode
    // Claude Code gives that folder was not checked, so the mode is set again here.
    chmodSync(slotFolder, SLOT_FOLDER_MODE);
    const slot: SessionStartCardSlot = { text: bannerText };
    // Written under another name and renamed: a card that looks for its slot while the hook
    // runs (it asked with a request file) never reads half a banner.
    writeTextFileAtomic(path.join(slotFolder, slotFileName), JSON.stringify(slot), { mode: SLOT_FILE_MODE });
  } catch (error) {
    logger.warn('HOOK', 'Session-start card file could not be written; sending the banner as the hook message', {
      slotFile,
      error: errorText(error),
    });
    return false;
  }
  pruneOldSlots(slotFolder, slotFileName, nowEpochMs);
  return true;
}

/**
 * How long the context hook waits for the request of its session, when the
 * event names no file and no such request is in the slot folder yet.
 *
 * The card writes its request while the hook runs, so the hook can list the
 * folder first. Measured for #6314 (2026-11-20, 8 starts, Claude Code 2.1.329,
 * macOS, a Team account), in time after Claude Code passed the event over the
 * hooks module:
 *
 * - the request was written after 90 to 269 ms;
 * - the hook finished after 148 to 347 ms, and lists the folder near its end;
 * - in 3 of the 8 starts the hook listed the folder first: the request came 5,
 *   21 and 86 ms after the hook had finished, and the card was not drawn.
 *
 * The hook process started 11 to 17 ms after the event was passed over, so a
 * hook that listed the folder the moment it started would still find the
 * latest request measured within 258 ms. The wait is 1.9 times that.
 * A machine slower than this one was not measured. A request later than the wait
 * loses that start's card and never the banner.
 */
export const SESSION_START_CARD_REQUEST_HOOK_WAIT_MS = 500;

/**
 * How often the waiting hook lists the slot folder. The wait is a poll and not
 * one sleep, so a request that is there ends it: of the three late requests
 * measured (5, 21 and 86 ms), each is answered at most this long after it is
 * written. One listing of the folder took 42 microseconds (the median of
 * 2000 listings of a folder of 14 files), and a whole wait makes 51 at most.
 */
export const SESSION_START_CARD_REQUEST_HOOK_POLL_EVERY_MS = 10;

/**
 * How many sleeps fit into the wait. The wait ends at this count too, so a
 * clock that stands still or is set back cannot lengthen it. Measured: this
 * many sleeps take 563 to 586 ms (10 waits), because each sleep runs a little
 * over; the clock ends a wait after 500 to 511 ms.
 */
const SESSION_START_CARD_REQUEST_HOOK_POLLS = SESSION_START_CARD_REQUEST_HOOK_WAIT_MS / SESSION_START_CARD_REQUEST_HOOK_POLL_EVERY_MS;

/** The clock the hook's wait runs on. Tests give their own. */
export interface SessionStartCardRequestWaitClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const SYSTEM_CLOCK: SessionStartCardRequestWaitClock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

/** What the slot folder says about the request of one session start. */
type RequestLook =
  /** The request of this session stands: `slotFile` is the slot the hook names in answer. */
  | { kind: 'standing'; slotFile: string }
  /** No request of this session yet, and a card has asked from this folder before: one may be on its way. */
  | { kind: 'not-yet'; slotFolder: string }
  /** No card looks for a slot of this start, and none will. */
  | { kind: 'none' };

const NO_REQUEST: RequestLook = { kind: 'none' };

/**
 * One listing of the slot folder, read for the request of `sessionId`.
 *
 * - `session.start` comes when the Claude Code process starts, so only a
 *   `startup` has a request of its own. A `/clear` and a compaction have none.
 * - The card draws on the terminal's own screen (TERMINAL_ENTRYPOINT).
 * - A request stands for 8 seconds. One that has run out is no longer looked
 *   for.
 * - A hooks module that did not load wrote no request, now or before.
 */
function lookForRequest(
  sessionId: string | undefined,
  sessionSource: string | undefined,
  environment: Record<string, string | undefined>,
  nowEpochMs: number,
): RequestLook {
  const pluginDataDirectory = environment.CLAUDE_PLUGIN_DATA;
  if (sessionSource !== 'startup' || environment.CLAUDE_CODE_ENTRYPOINT !== TERMINAL_ENTRYPOINT) return NO_REQUEST;
  if (!pluginDataDirectory || !path.isAbsolute(pluginDataDirectory) || !isFileNameSafeSessionId(sessionId)) return NO_REQUEST;
  const slotFolder = path.resolve(pluginDataDirectory, SESSION_START_CARD_FOLDER);
  let fileNames: string[];
  try {
    fileNames = readdirSync(slotFolder);
  } catch {
    // No slot folder: no card has asked.
    return NO_REQUEST;
  }
  let hasRequestOfThisSession = false;
  let hasRequestOfAnotherSession = false;
  for (const fileName of fileNames) {
    const askedAtEpochMs = sessionStartCardRequestClockOf(fileName, sessionId);
    if (askedAtEpochMs === null) {
      if (isSessionStartCardRequestFileName(fileName)) hasRequestOfAnotherSession = true;
      continue;
    }
    hasRequestOfThisSession = true;
    if (isSessionStartCardRequestStanding(askedAtEpochMs, nowEpochMs)) {
      return { kind: 'standing', slotFile: sessionStartCardSlotPath(pluginDataDirectory, sessionId, nowEpochMs) };
    }
  }
  // A request of this session that has run out is the only one this start gets.
  return !hasRequestOfThisSession && hasRequestOfAnotherSession ? { kind: 'not-yet', slotFolder } : NO_REQUEST;
}

/**
 * The slot the context hook names itself, when the event names none: the
 * card's `classic.SessionStart` hook did not run (on a Team or Enterprise
 * account the organization's plugin sends the event past it, #6314), and its
 * `session.start` hook asked with a request file instead
 * (src/shared/session-start-card-slot.ts). Undefined when no request of this
 * session stands at `nowEpochMs` (lookForRequest says when), and the whole
 * banner is then the hook message.
 */
export function sessionStartCardSlotForRequest(
  sessionId: string | undefined,
  sessionSource: string | undefined,
  environment: Record<string, string | undefined> = process.env,
  nowEpochMs: number = Date.now(),
): string | undefined {
  const look = lookForRequest(sessionId, sessionSource, environment, nowEpochMs);
  return look.kind === 'standing' ? look.slotFile : undefined;
}

/**
 * sessionStartCardSlotForRequest for the context hook, which can list the slot
 * folder before the card has written its request
 * (SESSION_START_CARD_REQUEST_HOOK_WAIT_MS has the measurement). It lists the
 * folder every SESSION_START_CARD_REQUEST_HOOK_POLL_EVERY_MS until the request
 * of this session stands, for SESSION_START_CARD_REQUEST_HOOK_WAIT_MS at most.
 *
 * It waits only when the folder holds a request of another session: a card
 * has asked from this plugin data folder before. Nothing tells the hook
 * whether the hooks module is loaded in its own Claude Code process: the
 * module's first hook with file access is `session.start`, which runs beside
 * this hook. So a start whose folder holds no request does not wait:
 *
 * - Claude Code without the card (before 2.1.326), whose hooks module never
 *   wrote a request into this folder;
 * - the first start after claude-mem is installed. On a Team or Enterprise
 *   account that start can still list the folder first and lose its card.
 *
 * A start with a named file, a `/clear`, a compaction and a session outside
 * the terminal never get here or end at the first listing (lookForRequest).
 *
 * A request of another session can be left by a Claude Code that no longer
 * loads the card. The wait then runs out, and deletes the card files older
 * than SESSION_START_CARD_SLOT_MAX_AGE_MS as a slot write does. So such a host
 * stops waiting once the newest request is that old and one more wait has run
 * out. A host with the card writes a request at each start.
 */
export async function awaitSessionStartCardSlotForRequest(
  sessionId: string | undefined,
  sessionSource: string | undefined,
  environment: Record<string, string | undefined> = process.env,
  clock: SessionStartCardRequestWaitClock = SYSTEM_CLOCK,
): Promise<string | undefined> {
  const giveUpAtEpochMs = clock.now() + SESSION_START_CARD_REQUEST_HOOK_WAIT_MS;
  for (let sleepsMade = 0; ; sleepsMade += 1) {
    const nowEpochMs = clock.now();
    const look = lookForRequest(sessionId, sessionSource, environment, nowEpochMs);
    if (look.kind === 'standing') return look.slotFile;
    if (look.kind === 'none') return undefined;
    if (nowEpochMs >= giveUpAtEpochMs || sleepsMade >= SESSION_START_CARD_REQUEST_HOOK_POLLS) {
      logger.debug('HOOK', 'No session-start card request came within the wait; sending the banner as the hook message', {
        waitedMs: SESSION_START_CARD_REQUEST_HOOK_WAIT_MS,
      });
      pruneOldSlots(look.slotFolder, null, nowEpochMs);
      return undefined;
    }
    await clock.sleep(SESSION_START_CARD_REQUEST_HOOK_POLL_EVERY_MS);
  }
}
