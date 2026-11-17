/**
 * The session-start card's hooks (card.ts says what the card is). They are
 * registered by src/mods/hooks-module.ts, claude-mem's one hooks module.
 *
 * As in every hooks module, `$` is only ever spelled `$.<namespace>.<method>(…)`
 * with literal names and is never passed to a helper.
 */
import {
  isFileNameSafeSessionId,
  SESSION_START_CARD_FILE_KEY,
  sessionStartCardSlotPath,
} from '../../shared/session-start-card-slot.js';
import {
  isSessionStartCardSource,
  sessionStartCardLines,
  supportsSessionStartCard,
  TERMINAL_ENTRYPOINT,
  type StyledRun,
} from './card.js';
import type { ElementFactory, On } from './mod-api.js';

/** The element factory: a global of a hooks module's environment. */
declare const h: ElementFactory;

const CARD_TITLE = 'claude-mem';

/** The one line a person reads when the card cannot be drawn: every failure in these hooks is reported with it. */
function cardNotShownLine(error: unknown): string {
  return `claude-mem: the session-start card is not shown: ${error instanceof Error ? error.message : String(error)}`;
}

export function registerSessionStartCard(on: On): void {
  /** The latest session start's card, and the id of the row that draws it. */
  let card: { rowId: string; lines: StyledRun[][] } | null = null;
  /** The terminal screen is up, so a row can be placed. SessionStart hooks can finish before it is. */
  let isSessionStarted = false;
  /** A card whose hooks finished before the screen was up: `session.start` places it. */
  let placeCardOnceSessionStarts: (() => Promise<void>) | null = null;

  on('classic.SessionStart', async ($, e, next) => {
    if (!isSessionStartCardSource(e.source) || !isFileNameSafeSessionId(e.session_id)) return next(e);

    let slotPath: string | null = null;
    let startedAtEpochMs = 0;
    try {
      if ((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === TERMINAL_ENTRYPOINT) {
        const engine = await $.session.version();
        if (supportsSessionStartCard(engine.base ?? engine.version)) {
          // The call makes the folder, and rejects when it cannot.
          const pluginDataDirectory = (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA;
          if (!pluginDataDirectory) throw new Error('Claude Code named no plugin data folder');
          startedAtEpochMs = await $.clock.now();
          slotPath = sessionStartCardSlotPath(pluginDataDirectory, e.session_id, startedAtEpochMs);
        }
      }
    } catch (error) {
      // No file is named, so the context hook sends its whole message: the banner still shows, and this line says why it is not a card.
      $.ui.log(cardNotShownLine(error));
    }
    // No card here: the event goes on untouched, and the context hook sends its whole message.
    if (slotPath === null) return next(e);
    const slotFile = slotPath;

    const result = await next({ ...e, [SESSION_START_CARD_FILE_KEY]: slotFile });
    try {
      // No file: the context hook sent its own message (the preview is off, there is nothing to show, an older claude-mem).
      if (!(await $.fs.exists(slotFile))) return result;
      const lines = sessionStartCardLines(await $.fs.read(slotFile));
      if (!lines) throw new Error(`${slotFile} holds no banner`);
      // A row id of its own per start: after a compaction that keeps the old row, the new card still lands at the end.
      const rowId = `session-start-${startedAtEpochMs}`;
      card = { rowId, lines };
      const placeCard = async (): Promise<void> => {
        try {
          const placed = await $.ui.place({ id: rowId });
          if (!placed.isPlaced && placed.requestId === undefined) throw new Error(placed.reason);
          // An earlier start's row is asked again, and now draws nothing.
          $.ui.invalidate('ui.render');
        } catch (error) {
          $.ui.log(cardNotShownLine(error));
        }
      };
      if (isSessionStarted) await placeCard();
      else placeCardOnceSessionStarts = placeCard;
    } catch (error) {
      $.ui.log(cardNotShownLine(error));
    }
    return result;
  }).catch(async ($, e, next) => next(e));

  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e);
    isSessionStarted = true;
    const placeCard = placeCardOnceSessionStarts;
    placeCardOnceSessionStarts = null;
    if (placeCard) await placeCard();
    return result;
  });

  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    // Every plugin's hook hears every placed row: draw only this plugin's latest card.
    if (!card || e.props.plugin !== $.plugin.name || e.props.id !== card.rowId) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return h(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'claude', paddingX: 1 },
      h(Text, { weight: 'bold', color: 'claude' }, CARD_TITLE),
      card.lines.map(runs =>
        h(
          Text,
          null,
          // A Text with nothing in it takes no row; a space keeps the blank line.
          runs.length === 0
            ? ' '
            : runs.map(run => h(Text, { color: run.color, dimColor: run.isDim, weight: run.isBold ? 'bold' : undefined }, run.text)),
        ),
      ),
    );
  });
}
