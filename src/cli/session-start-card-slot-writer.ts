/**
 * The context hook's half of the session-start card handoff
 * (src/shared/session-start-card-slot.ts): it writes the terminal banner into
 * the file the card named, for the card to draw.
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import {
  isSessionStartCardSlotFileName,
  isSessionStartCardSlotFileNameOf,
  SESSION_START_CARD_FOLDER,
  type SessionStartCardSlot,
} from '../shared/session-start-card-slot.js';

/**
 * A slot file this old is deleted the next time a session writes one. The
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
      if (fileName === writtenFileName || !isSessionStartCardSlotFileName(fileName)) continue;
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
    const slot: SessionStartCardSlot = { text: bannerText };
    writeFileSync(path.join(slotFolder, slotFileName), JSON.stringify(slot), { mode: SLOT_FILE_MODE });
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
