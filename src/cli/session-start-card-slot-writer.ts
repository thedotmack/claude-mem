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
 * A slot file this old is deleted the next time a session writes one. So is a
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

function pruneOldSlots(slotFolder: string, writtenFileName: string, nowEpochMs: number): void {
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
 * The slot the context hook names itself, when the event names none: the
 * card's `classic.SessionStart` hook did not run (on a Team or Enterprise
 * account the organization's plugin sends the event past it, #6314), and its
 * `session.start` hook asked with a request file instead
 * (src/shared/session-start-card-slot.ts). Undefined when no card looks for
 * such a slot, and the whole banner is then the hook message:
 *
 * - `session.start` comes when the Claude Code process starts, so only a
 *   `startup` has a request of its own. A `/clear` and a compaction have none.
 * - The card draws on the terminal's own screen (TERMINAL_ENTRYPOINT).
 * - A request stands for 8 seconds. One that has run out is no longer looked
 *   for, and a hooks module that did not load wrote none.
 */
export function sessionStartCardSlotForRequest(
  sessionId: string | undefined,
  sessionSource: string | undefined,
  environment: Record<string, string | undefined> = process.env,
  nowEpochMs: number = Date.now(),
): string | undefined {
  const pluginDataDirectory = environment.CLAUDE_PLUGIN_DATA;
  if (sessionSource !== 'startup' || environment.CLAUDE_CODE_ENTRYPOINT !== TERMINAL_ENTRYPOINT) return undefined;
  if (!pluginDataDirectory || !path.isAbsolute(pluginDataDirectory) || !isFileNameSafeSessionId(sessionId)) return undefined;
  let fileNames: string[];
  try {
    fileNames = readdirSync(path.resolve(pluginDataDirectory, SESSION_START_CARD_FOLDER));
  } catch {
    // No slot folder: no card has asked.
    return undefined;
  }
  const isAsked = fileNames.some(fileName => {
    const askedAtEpochMs = sessionStartCardRequestClockOf(fileName, sessionId);
    return askedAtEpochMs !== null && isSessionStartCardRequestStanding(askedAtEpochMs, nowEpochMs);
  });
  return isAsked ? sessionStartCardSlotPath(pluginDataDirectory, sessionId, nowEpochMs) : undefined;
}
