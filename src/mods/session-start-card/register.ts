/**
 * The session-start card's hooks (card.ts says what the card is). They are
 * registered by src/mods/hooks-module.ts, claude-mem's one hooks module.
 *
 * As in every hooks module, `$` is only ever spelled `$.<namespace>.<method>(…)`
 * with literal names and is never passed to a helper.
 */
import {
  isFileNameSafeSessionId,
  newestSessionStartCardSlotSince,
  SESSION_START_CARD_FILE_KEY,
  SESSION_START_CARD_FOLDER,
  SESSION_START_CARD_REQUEST_LOOK_EVERY_MS,
  SESSION_START_CARD_REQUEST_WAIT_MS,
  sessionStartCardRequestPath,
  sessionStartCardSlotPath,
} from '../../shared/session-start-card-slot.js';
import {
  COMPACT_SOURCE,
  drawsSessionStartCard,
  sessionStartCardLines,
  supportsSessionStartCard,
  TERMINAL_ENTRYPOINT,
  TERMINAL_SURFACE,
  type StyledRun,
} from './card.js';
import { sessionStartMark } from './brand-mark.js';
import type { ElementFactory, On } from './mod-api.js';

/** The element factory: a global of a hooks module's environment. */
declare const h: ElementFactory;

const CARD_TITLE = 'claude-mem';
// Keep the logo near the title. Longer timelines use the full card width below it.
const MAX_LINES_BESIDE_MARK = 15;

/** One session start's card: the banner's lines, and the id of the row that draws them. */
interface Card {
  rowId: string;
  lines: StyledRun[][];
}

/** What a session start adds to the transcript: its card, or the line that says why there is none. */
type CardAddition = { card: Card } | { notShownLine: string };

/**
 * The debug-log line of a start whose card asked with a request file and found
 * no slot in the whole wait: the context hook did not run (a resumed session),
 * had no banner to hand over, or took longer than the request stands. Each of
 * them leaves its message as it is, so the line goes to the debug log and not
 * into the transcript of every resumed session.
 */
const NO_BANNER_FOUND_LINE = `claude-mem: the session-start card found no banner in the ${SESSION_START_CARD_REQUEST_WAIT_MS / 1000} s after the session started, and stopped looking`;

/** The one line a person reads when the card cannot be drawn: every failure in these hooks is reported with it. */
function cardNotShownLine(error: unknown): string {
  return `claude-mem: the session-start card is not shown: ${error instanceof Error ? error.message : String(error)}`;
}

export function registerSessionStartCard(on: On): void {
  /** The card on screen: the latest one placed. */
  let card: Card | null = null;
  /** Which of the terminal's two layouts this session draws on, as its drawings say; null before the first. */
  let isFullscreen: boolean | null = null;
  /**
   * What the latest startup or `/clear` has yet to add to the transcript: the
   * `session.append` hook below adds it, and says why it waits.
   */
  let waitingForHookRows: CardAddition | null = null;
  /**
   * The session whose start the `classic.SessionStart` hook named a slot for.
   * That hook places the card of such a start, so the `session.start` hook
   * below never does: one start, one card.
   */
  let sessionWithNamedSlot: string | null = null;

  on('classic.SessionStart', async ($, e, next) => {
    // What an earlier start never got to add is not this start's to add.
    waitingForHookRows = null;
    if (!drawsSessionStartCard(e.source, isFullscreen) || !isFileNameSafeSessionId(e.session_id)) return next(e);

    let addition: CardAddition | null = null;
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
      addition = { notShownLine: cardNotShownLine(error) };
    }

    let result: unknown;
    if (slotPath === null) {
      // No card here: the event goes on untouched, and the context hook sends its whole message.
      result = await next(e);
    } else {
      const slotFile = slotPath;
      // Set before the command hooks run, so before the slot can be there for the `session.start` hook to find.
      sessionWithNamedSlot = e.session_id;
      result = await next({ ...e, [SESSION_START_CARD_FILE_KEY]: slotFile });
      try {
        // No file: the context hook sent its own message (the preview is off, there is nothing to show, an older claude-mem).
        if (await $.fs.exists(slotFile)) {
          const lines = sessionStartCardLines(await $.fs.read(slotFile));
          if (!lines) throw new Error(`${slotFile} holds no banner`);
          // A row id of its own per start: after a compaction that keeps the old row, the new card still lands at the end.
          addition = { card: { rowId: `session-start-${startedAtEpochMs}`, lines } };
        }
      } catch (error) {
        addition = { notShownLine: cardNotShownLine(error) };
      }
    }
    if (addition === null) return result;
    if (e.source !== COMPACT_SOURCE) {
      waitingForHookRows = addition;
      return result;
    }

    // A compaction, on the fullscreen layout (drawsSessionStartCard): no row comes after its hook rows, so the card goes in now.
    if ('notShownLine' in addition) {
      $.ui.log(addition.notShownLine);
      return result;
    }
    // The row's first drawing must find this card, and a card that is not placed must not blank the one before it.
    const cardBeforeThisCompaction = card;
    card = addition.card;
    try {
      const placed = await $.ui.place({ id: addition.card.rowId });
      if (!placed.isPlaced && placed.requestId === undefined) throw new Error(placed.reason);
      // An earlier start's row is asked again, and now draws nothing.
      $.ui.invalidate('ui.render');
    } catch (error) {
      card = cardBeforeThisCompaction;
      $.ui.log(cardNotShownLine(error));
    }
    return result;
  }).catch(async ($, e, next) => next(e));

  /**
   * The card of a startup or a `/clear`, or the line in its place, joins the
   * transcript only here: once Claude Code has kept the last row of that
   * start's hooks.
   *
   * Claude Code keeps those rows after the SessionStart hook above has
   * returned, one at a time, at the top of the transcript; a placed row and a
   * logged line go to its end at once. The terminal's main screen cannot print
   * a row above one it has already printed, so a card or a line added any
   * earlier keeps every plugin's SessionStart message off that screen (seen on
   * Claude Code 2.1.326).
   *
   * The last of those rows is the hooks' combined context, which Claude Code
   * makes whenever a hook gave any. The context hook writes a card's file only
   * with context of its own (src/cli/handlers/context.ts), so a card always
   * has this row to wait for. A line has it unless no hook gave context, and
   * then it is not shown: no file was named, so the hook message carries the
   * whole banner anyway.
   */
  on(
    'session.append',
    { door: 'hook-context', origin: { kind: 'hook', event: 'SessionStart' }, message: { name: 'hook_additional_context' } },
    async ($, e, next) => {
      const keptRow = await next(e);
      const addition = waitingForHookRows;
      waitingForHookRows = null;
      if (addition === null) return keptRow;
      if ('notShownLine' in addition) {
        $.ui.log(addition.notShownLine);
        return keptRow;
      }
      // The row's first drawing must find this card, and a card that is not placed must not blank the one before it.
      const cardBeforeThisStart = card;
      card = addition.card;
      try {
        const placed = await $.ui.place({ id: addition.card.rowId });
        if (!placed.isPlaced && placed.requestId === undefined) throw new Error(placed.reason);
        // An earlier start's row is asked again, and now draws nothing.
        $.ui.invalidate('ui.render');
      } catch (error) {
        card = cardBeforeThisStart;
        $.ui.log(cardNotShownLine(error));
      }
      return keptRow;
    },
  );

  /**
   * The card of a session whose `classic.SessionStart` never reaches the hook
   * above. On a Team or Enterprise account the organization's plugin runs
   * first and sends that event, and `session.append`, past this module
   * (#6314). `session.start` still arrives: when the Claude Code process
   * starts, and again when Claude Code reloads the plugin. So this hook asks
   * for the banner with a request file, and looks for the slot the context
   * hook names in answer (src/shared/session-start-card-slot.ts). After a
   * reload no SessionStart hook runs, and the request runs out unanswered.
   *
   * The request is what keeps the banner: the context hook sends its one-line
   * message only when it finds one, so a session whose hooks module did not
   * load, a `/clear` and a compaction (no `session.start` comes with them)
   * keep the whole banner as the hook message.
   *
   * The card is placed as soon as the slot is there. This hook cannot wait for
   * the hooks' combined-context row as the `session.append` hook above does,
   * because that event does not reach it on these accounts.
   *
   * auto-clear has the hooks module's one `session.start` hook without a
   * matcher (src/mods/hooks-module.ts), so this one is under a matcher. A
   * session with nobody at the prompt has no terminal screen to draw on.
   */
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    try {
      if ((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === TERMINAL_ENTRYPOINT) {
        const engine = await $.session.version();
        if (supportsSessionStartCard(engine.base ?? engine.version)) {
          const sessionId = await $.session.id();
          const pluginDataDirectory = (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA;
          if (pluginDataDirectory && isFileNameSafeSessionId(sessionId) && sessionWithNamedSlot !== sessionId) {
            const slotFolder = `${pluginDataDirectory.replace(/[\\/]+$/, '')}/${SESSION_START_CARD_FOLDER}`;
            // Read before the request is written: the context hook names its slot by a later clock.
            const askedAtEpochMs = await $.clock.now();
            await $.fs.write(sessionStartCardRequestPath(pluginDataDirectory, sessionId, askedAtEpochMs), '');
            let isLooking = false;
            /** Whether the timer is cancelled. A tick or a look that is under way then says no more about the wait. */
            let hasStoppedLooking = false;
            const stopLooking = () => {
              hasStoppedLooking = true;
              looks.cancel();
            };
            const looks = $.clock.every(SESSION_START_CARD_REQUEST_LOOK_EVERY_MS, async () => {
              if (hasStoppedLooking) return;
              try {
                // The wait ends by the clock, and not after a count of listings: a listing that takes longer
                // than the time between two looks, or never settles, does not lengthen it.
                const isWaitOver = (await $.clock.now()) - askedAtEpochMs >= SESSION_START_CARD_REQUEST_WAIT_MS;
                // The looks were stopped while the clock was read.
                if (hasStoppedLooking) return;
                if (isLooking) {
                  // A look that takes longer than the time between two looks is not joined by a second one.
                  if (!isWaitOver) return;
                  // The wait is over with a listing still pending: that listing is the last look. It still
                  // places the card when it shows the slot, and says nothing more when it does not.
                  stopLooking();
                  $.ui.log(NO_BANNER_FOUND_LINE, { to: 'debug' });
                  return;
                }
                isLooking = true;
                try {
                  if (sessionWithNamedSlot === sessionId) {
                    stopLooking();
                    return;
                  }
                  const slot = newestSessionStartCardSlotSince(
                    (await $.fs.list(slotFolder)).map(entry => entry.name),
                    sessionId,
                    askedAtEpochMs,
                  );
                  // Asked again after the listing: the slot it shows may be the one the other hook named meanwhile.
                  if (sessionWithNamedSlot === sessionId) {
                    stopLooking();
                    return;
                  }
                  if (slot === null) {
                    // Before the wait is over the next tick looks again. After a tick has stopped the looks, that tick has said so.
                    if (!isWaitOver || hasStoppedLooking) return;
                    // The last look, made no sooner than the wait after the card asked, found no slot.
                    stopLooking();
                    $.ui.log(NO_BANNER_FOUND_LINE, { to: 'debug' });
                    return;
                  }
                  stopLooking();
                  const slotFile = `${slotFolder}/${slot.fileName}`;
                  const lines = sessionStartCardLines(await $.fs.read(slotFile));
                  if (!lines) throw new Error(`${slotFile} holds no banner`);
                  // The slot's clock is a whole number, as a row id has to be; the file's modification time is not.
                  const requestedCard: Card = { rowId: `session-start-${slot.clockEpochMs}`, lines };
                  // The row's first drawing must find this card, and a card that is not placed must not blank the one before it.
                  const cardBeforeThisStart = card;
                  card = requestedCard;
                  try {
                    const placed = await $.ui.place({ id: requestedCard.rowId });
                    if (!placed.isPlaced && placed.requestId === undefined) throw new Error(placed.reason);
                    // An earlier start's row is asked again, and now draws nothing.
                    $.ui.invalidate('ui.render');
                  } catch (error) {
                    card = cardBeforeThisStart;
                    throw error;
                  }
                } finally {
                  isLooking = false;
                }
              } catch (error) {
                stopLooking();
                $.ui.log(cardNotShownLine(error));
              }
            });
          }
        }
      }
    } catch (error) {
      // No request was written, or nothing looks for its slot. The classic hook reports the same failure on
      // an account where it runs, so this one goes to the debug log: one line on screen, not two.
      $.ui.log(cardNotShownLine(error), { to: 'debug' });
    }
    return next(e);
  });

  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    // Any placed row drawn on the terminal says which layout the session is on.
    if (e.surface === TERMINAL_SURFACE && typeof e.viewport?.isFullscreen === 'boolean') isFullscreen = e.viewport.isFullscreen;
    // Every plugin's hook hears every placed row: draw only this plugin's latest card.
    if (!card || e.props.plugin !== $.plugin.name || e.props.id !== card.rowId) return next(e);
    const { Box, Text, Raster } = $.ui.resolve(e);
    const frame = { flexDirection: 'column', borderStyle: 'round', borderColor: 'claude', paddingX: 1 };
    const title = h(Text, { weight: 'bold', color: 'claude' }, CARD_TITLE);
    const lines = card.lines.map(runs =>
      h(
        Text,
        null,
        // A Text with nothing in it takes no row; a space keeps the blank line.
        runs.length === 0
          ? ' '
          : runs.map(run => h(Text, { color: run.color, dimColor: run.isDim, weight: run.isBold ? 'bold' : undefined }, run.text)),
      ),
    );
    const mark = e.surface === TERMINAL_SURFACE ? sessionStartMark(e.viewport?.columns ?? 0, e.viewport?.rows) : undefined;
    if (!mark) return h(Box, frame, title, lines);
    return h(
      Box,
      frame,
      h(
        Box,
        { flexDirection: 'row', columnGap: 2 },
        h(Box, { flexDirection: 'column', minWidth: 0, flexGrow: 1 }, title, lines.slice(0, MAX_LINES_BESIDE_MARK)),
        h(
          Box,
          { flexDirection: 'column', width: mark.columns, flexShrink: 0, alignSelf: 'center' },
          h(Raster, { key: 'brand-mark', ...mark }),
        ),
      ),
      lines.slice(MAX_LINES_BESIDE_MARK),
    );
  });
}
