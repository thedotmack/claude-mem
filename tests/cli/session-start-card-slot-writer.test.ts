import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  awaitSessionStartCardSlotForRequest,
  SESSION_START_CARD_REQUEST_HOOK_POLL_EVERY_MS,
  SESSION_START_CARD_REQUEST_HOOK_WAIT_MS,
  SESSION_START_CARD_SLOT_MAX_AGE_MS,
  sessionStartCardSlotForRequest,
  writeSessionStartCardSlot,
} from '../../src/cli/session-start-card-slot-writer.js';
import { sessionStartCardLines } from '../../src/mods/session-start-card/card.js';
import {
  newestSessionStartCardSlotSince,
  SESSION_START_CARD_FOLDER,
  SESSION_START_CARD_REQUEST_LOOK_EVERY_MS,
  SESSION_START_CARD_REQUEST_WAIT_MS,
  sessionStartCardRequestPath,
  sessionStartCardSlotPath,
} from '../../src/shared/session-start-card-slot.js';

const SESSION_ID = '0b6f6e0c-11aa-4c1e-9d5e-2f3b6a7c8d9e';

describe('writeSessionStartCardSlot', () => {
  let pluginDataDirectory: string;
  let slotFolder: string;
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;

  beforeEach(() => {
    pluginDataDirectory = mkdtempSync(path.join(tmpdir(), 'session-start-card-slot-'));
    slotFolder = path.join(pluginDataDirectory, SESSION_START_CARD_FOLDER);
    delete process.env.CLAUDE_PLUGIN_DATA;
  });
  afterEach(() => {
    rmSync(pluginDataDirectory, { recursive: true, force: true });
    if (savedPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
  });

  it('writes the banner to the file the card named, in the form the card reads', () => {
    // The path as the card builds it, from the same data folder Claude Code gives the hook.
    const slotFile = sessionStartCardSlotPath(pluginDataDirectory, SESSION_ID, 1794888786050);
    expect(writeSessionStartCardSlot(slotFile, SESSION_ID, 'header\n\n\x1b[2m#1\x1b[0m row', pluginDataDirectory)).toBe(true);
    expect(JSON.parse(readFileSync(slotFile, 'utf-8'))).toEqual({ text: 'header\n\n\x1b[2m#1\x1b[0m row' });
    expect(sessionStartCardLines(readFileSync(slotFile, 'utf-8'))).toHaveLength(3);
  });

  // The banner is memory text, and the plugin data folder is outside claude-mem's owner-only data directory.
  it.skipIf(process.platform === 'win32')('makes the slot folder and the slot readable by their owner only', () => {
    const slotFile = sessionStartCardSlotPath(pluginDataDirectory, SESSION_ID, 1);
    expect(writeSessionStartCardSlot(slotFile, SESSION_ID, 'banner', pluginDataDirectory)).toBe(true);
    expect(statSync(slotFile).mode & 0o777).toBe(0o600);
    expect(statSync(slotFolder).mode & 0o777).toBe(0o700);
  });

  it('reads the plugin data folder from CLAUDE_PLUGIN_DATA, which Claude Code sets for the hook', () => {
    const slotFile = sessionStartCardSlotPath(pluginDataDirectory, SESSION_ID, 1);
    expect(writeSessionStartCardSlot(slotFile, SESSION_ID, 'banner')).toBe(false);
    process.env.CLAUDE_PLUGIN_DATA = pluginDataDirectory;
    expect(writeSessionStartCardSlot(slotFile, SESSION_ID, 'banner')).toBe(true);
    expect(existsSync(slotFile)).toBe(true);
  });

  it('writes nothing for a path that is not a slot of this session in the plugin data folder', () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'session-start-card-elsewhere-'));
    try {
      const refused: Array<[string, string, string | undefined]> = [
        ['outside the data folder', path.join(elsewhere, SESSION_START_CARD_FOLDER, `${SESSION_ID}.1.json`), SESSION_ID],
        ['in the data folder itself', path.join(pluginDataDirectory, `${SESSION_ID}.1.json`), SESSION_ID],
        ['in a folder below the slot folder', path.join(slotFolder, 'deeper', `${SESSION_ID}.1.json`), SESSION_ID],
        ['another session\'s slot', path.join(slotFolder, 'another-session.1.json'), SESSION_ID],
        ['not a slot name', path.join(slotFolder, 'settings.json'), SESSION_ID],
        ['a slot name with a tail', path.join(slotFolder, `${SESSION_ID}.1.json.sh`), SESSION_ID],
        ['a relative path', path.join(SESSION_START_CARD_FOLDER, `${SESSION_ID}.1.json`), SESSION_ID],
        ['no session id', path.join(slotFolder, `${SESSION_ID}.1.json`), undefined],
        ['an empty session id', path.join(slotFolder, '.1.json'), ''],
      ];
      for (const [name, slotFile, sessionId] of refused) {
        expect([name, writeSessionStartCardSlot(slotFile, sessionId, 'banner', pluginDataDirectory)]).toEqual([name, false]);
        expect([name, existsSync(slotFile)]).toEqual([name, false]);
      }
      expect(existsSync(slotFolder)).toBe(false);
      expect(readdirSync(elsewhere)).toEqual([]);

      // A path that climbs out and back in still names a file in the slot folder, and is written there.
      const roundabout = `${pluginDataDirectory}/other/../${SESSION_START_CARD_FOLDER}/${SESSION_ID}.2.json`;
      expect(writeSessionStartCardSlot(roundabout, SESSION_ID, 'banner', pluginDataDirectory)).toBe(true);
      expect(readdirSync(slotFolder)).toEqual([`${SESSION_ID}.2.json`]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses when no plugin data folder is known, or it is not an absolute path', () => {
    const slotFile = sessionStartCardSlotPath(pluginDataDirectory, SESSION_ID, 1);
    expect(writeSessionStartCardSlot(slotFile, SESSION_ID, 'banner', undefined)).toBe(false);
    expect(writeSessionStartCardSlot(slotFile, SESSION_ID, 'banner', '')).toBe(false);
    expect(writeSessionStartCardSlot(slotFile, SESSION_ID, 'banner', 'relative/data')).toBe(false);
    expect(existsSync(slotFile)).toBe(false);
  });

  it('reports a file it cannot write, so the hook sends the banner itself', () => {
    // A file where the slot folder should be: the folder cannot be made.
    writeFileSync(slotFolder, 'not a folder');
    const slotFile = sessionStartCardSlotPath(pluginDataDirectory, SESSION_ID, 1);
    expect(writeSessionStartCardSlot(slotFile, SESSION_ID, 'banner', pluginDataDirectory)).toBe(false);
  });

  it('deletes slot files older than an hour and nothing else', () => {
    const nowEpochMs = Date.UTC(2026, 10, 16, 12, 0, 0);
    mkdirSync(slotFolder, { recursive: true });
    const fileAgedMs = (fileName: string, ageMs: number) => {
      const filePath = path.join(slotFolder, fileName);
      writeFileSync(filePath, '{"text":"old banner"}');
      const modifiedAtSeconds = (nowEpochMs - ageMs) / 1000;
      utimesSync(filePath, modifiedAtSeconds, modifiedAtSeconds);
    };
    fileAgedMs('old-session.1.json', SESSION_START_CARD_SLOT_MAX_AGE_MS + 60_000);
    fileAgedMs('older-session.2.json', 30 * SESSION_START_CARD_SLOT_MAX_AGE_MS);
    fileAgedMs('starting-now.3.json', 5_000);
    fileAgedMs('just-under-an-hour.4.json', SESSION_START_CARD_SLOT_MAX_AGE_MS - 60_000);
    fileAgedMs('notes.txt', 30 * SESSION_START_CARD_SLOT_MAX_AGE_MS);
    // An earlier start of this session that is written again now is kept.
    fileAgedMs(`${SESSION_ID}.5.json`, 30 * SESSION_START_CARD_SLOT_MAX_AGE_MS);

    const slotFile = sessionStartCardSlotPath(pluginDataDirectory, SESSION_ID, 5);
    expect(writeSessionStartCardSlot(slotFile, SESSION_ID, 'new banner', pluginDataDirectory, nowEpochMs)).toBe(true);
    expect(readdirSync(slotFolder).sort()).toEqual([
      `${SESSION_ID}.5.json`,
      'just-under-an-hour.4.json',
      'notes.txt',
      'starting-now.3.json',
    ]);
    expect(JSON.parse(readFileSync(slotFile, 'utf-8'))).toEqual({ text: 'new banner' });
  });

  it('deletes request files older than an hour with the slots, and keeps a request that stands', () => {
    const nowEpochMs = Date.UTC(2026, 10, 20, 12, 0, 0);
    mkdirSync(slotFolder, { recursive: true });
    const requestAgedMs = (fileName: string, ageMs: number) => {
      const filePath = path.join(slotFolder, fileName);
      writeFileSync(filePath, '');
      const modifiedAtSeconds = (nowEpochMs - ageMs) / 1000;
      utimesSync(filePath, modifiedAtSeconds, modifiedAtSeconds);
    };
    requestAgedMs('old-session.1.request', SESSION_START_CARD_SLOT_MAX_AGE_MS + 60_000);
    requestAgedMs(`${SESSION_ID}.2.request`, 300);
    requestAgedMs('notes.request', 30 * SESSION_START_CARD_SLOT_MAX_AGE_MS);

    const slotFile = sessionStartCardSlotPath(pluginDataDirectory, SESSION_ID, 3);
    expect(writeSessionStartCardSlot(slotFile, SESSION_ID, 'banner', pluginDataDirectory, nowEpochMs)).toBe(true);
    expect(readdirSync(slotFolder).sort()).toEqual([`${SESSION_ID}.2.request`, `${SESSION_ID}.3.json`, 'notes.request']);
  });

  // The card's request file is written first, through Claude Code, which makes the folder with its own mode.
  it.skipIf(process.platform === 'win32')('makes a slot folder the request made readable by its owner only', () => {
    mkdirSync(slotFolder, { recursive: true, mode: 0o755 });
    chmodSync(slotFolder, 0o755);
    const slotFile = sessionStartCardSlotPath(pluginDataDirectory, SESSION_ID, 1);
    expect(writeSessionStartCardSlot(slotFile, SESSION_ID, 'banner', pluginDataDirectory)).toBe(true);
    expect(statSync(slotFolder).mode & 0o777).toBe(0o700);
    expect(statSync(slotFile).mode & 0o777).toBe(0o600);
  });
});

/**
 * A Team or Enterprise account (#6314): the event names no file, and the card
 * asked with a request file when the Claude Code process started.
 */
describe('sessionStartCardSlotForRequest', () => {
  let pluginDataDirectory: string;
  let slotFolder: string;
  const askedAt = Date.UTC(2026, 10, 20, 12, 0, 0);
  /** The measured case: the hook names its slot 0.3 s after the card asked. */
  const answeredAt = askedAt + 300;
  const terminal = () => ({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PLUGIN_DATA: pluginDataDirectory });
  /** The request as the card writes it: an empty file named by the same function. */
  const cardAsks = (sessionId: string, atEpochMs: number) => {
    mkdirSync(slotFolder, { recursive: true });
    writeFileSync(sessionStartCardRequestPath(pluginDataDirectory, sessionId, atEpochMs), '');
  };

  beforeEach(() => {
    pluginDataDirectory = mkdtempSync(path.join(tmpdir(), 'session-start-card-request-'));
    slotFolder = path.join(pluginDataDirectory, SESSION_START_CARD_FOLDER);
  });
  afterEach(() => {
    rmSync(pluginDataDirectory, { recursive: true, force: true });
  });

  it('names a slot of the session by the hook\'s own clock, which the slot writer takes and the card\'s look finds', () => {
    cardAsks(SESSION_ID, askedAt);
    const slotFile = sessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), answeredAt);
    expect(slotFile).toBe(sessionStartCardSlotPath(pluginDataDirectory, SESSION_ID, answeredAt));

    expect(writeSessionStartCardSlot(slotFile!, SESSION_ID, 'banner', pluginDataDirectory, answeredAt)).toBe(true);
    expect(newestSessionStartCardSlotSince(readdirSync(slotFolder), SESSION_ID, askedAt)).toEqual({
      fileName: `${SESSION_ID}.${answeredAt}.json`,
      clockEpochMs: answeredAt,
    });
  });

  it('names nothing without a request of this session that still stands, so the whole banner stays the hook message', () => {
    // No slot folder at all: the hooks module did not load, or the card cannot draw in this session.
    expect(sessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), answeredAt)).toBeUndefined();

    cardAsks('another-session', askedAt);
    expect(sessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), answeredAt)).toBeUndefined();

    cardAsks(SESSION_ID, askedAt);
    // The control: this request is answered while it stands, up to one look before the card's last.
    const lastAnswerAt = askedAt + SESSION_START_CARD_REQUEST_WAIT_MS - SESSION_START_CARD_REQUEST_LOOK_EVERY_MS;
    expect(sessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), askedAt)).toBeDefined();
    expect(sessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), lastAnswerAt)).toBeDefined();
    // Run out: the card has stopped looking, or is about to.
    expect(sessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), lastAnswerAt + 1)).toBeUndefined();
    expect(sessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), askedAt + SESSION_START_CARD_SLOT_MAX_AGE_MS)).toBeUndefined();
    // A request from a clock ahead of the hook's.
    expect(sessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), askedAt - 1)).toBeUndefined();
  });

  it('answers a request only at the start of the process, on the terminal, inside the plugin data folder', () => {
    cardAsks(SESSION_ID, askedAt);
    expect(sessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), answeredAt)).toBeDefined();

    // session.start does not come with a /clear or a compaction, so no card looks for their banner.
    for (const source of ['clear', 'compact', 'resume', undefined]) {
      expect([source, sessionStartCardSlotForRequest(SESSION_ID, source, terminal(), answeredAt)]).toEqual([source, undefined]);
    }
    for (const entrypoint of ['sdk-cli', 'claude-desktop', undefined]) {
      const environment = { ...terminal(), CLAUDE_CODE_ENTRYPOINT: entrypoint };
      expect([entrypoint, sessionStartCardSlotForRequest(SESSION_ID, 'startup', environment, answeredAt)]).toEqual([entrypoint, undefined]);
    }
    for (const dataDirectory of [undefined, '', path.relative(process.cwd(), pluginDataDirectory)]) {
      const environment = { ...terminal(), CLAUDE_PLUGIN_DATA: dataDirectory };
      expect([dataDirectory, sessionStartCardSlotForRequest(SESSION_ID, 'startup', environment, answeredAt)]).toEqual([dataDirectory, undefined]);
    }
    for (const sessionId of [undefined, '', '../another-session']) {
      expect([sessionId, sessionStartCardSlotForRequest(sessionId, 'startup', terminal(), answeredAt)]).toEqual([sessionId, undefined]);
    }
  });
});

/**
 * The order measured on a Team account (#6314, 8 starts on Claude Code
 * 2.1.329): the card writes its request while the context hook runs, and in 3
 * of the 8 the hook listed the slot folder first.
 */
describe('awaitSessionStartCardSlotForRequest', () => {
  let pluginDataDirectory: string;
  let slotFolder: string;
  /** The hook's first listing of the slot folder. Close to the real clock, which dates the files the prune reads. */
  let hookListsAt: number;
  const terminal = () => ({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PLUGIN_DATA: pluginDataDirectory });
  const cardAsks = (sessionId: string, atEpochMs: number) => {
    mkdirSync(slotFolder, { recursive: true });
    const requestFile = sessionStartCardRequestPath(pluginDataDirectory, sessionId, atEpochMs);
    writeFileSync(requestFile, '');
    return requestFile;
  };
  /**
   * The hook's clock, in a test's hands: each sleep moves it on. The request
   * of `sessionId` is written at `requestWrittenAt`, where the card's
   * `$.fs.write` lands it, under the clock the card read before (`askedAt`).
   * With null no request is written.
   */
  const clockWhereTheCardWritesAt = (requestWrittenAt: number | null, sessionId: string = SESSION_ID, askedAt: number = hookListsAt) => {
    const clock = {
      nowEpochMs: hookListsAt,
      sleeps: [] as number[],
      now: () => clock.nowEpochMs,
      sleep: async (ms: number) => {
        clock.sleeps.push(ms);
        // A wait with no end fails here and not at the test's timeout.
        if (clock.sleeps.length > 1000) throw new Error('the hook waits without end');
        const sleptUntil = clock.nowEpochMs + ms;
        if (requestWrittenAt !== null && clock.nowEpochMs < requestWrittenAt && requestWrittenAt <= sleptUntil) cardAsks(sessionId, askedAt);
        clock.nowEpochMs = sleptUntil;
      },
    };
    return clock;
  };

  beforeEach(() => {
    pluginDataDirectory = mkdtempSync(path.join(tmpdir(), 'session-start-card-await-'));
    slotFolder = path.join(pluginDataDirectory, SESSION_START_CARD_FOLDER);
    hookListsAt = Date.now();
  });
  afterEach(() => {
    rmSync(pluginDataDirectory, { recursive: true, force: true });
  });

  it('waits for a request the card writes after the hook has listed the folder, and the card still gets its slot', async () => {
    // The three late requests measured: 5, 21 and 86 ms after the hook had finished.
    for (const [index, requestIsLateByMs] of [5, 21, 86].entries()) {
      const sessionId = `${SESSION_ID}-${index}`;
      // An earlier session's request: a card has asked from this plugin data folder before.
      cardAsks('an-earlier-session', hookListsAt - 60_000);
      // The card reads its clock, and its write lands after the hook's first listing.
      const askedAt = hookListsAt - 30;
      const clock = clockWhereTheCardWritesAt(hookListsAt + requestIsLateByMs, sessionId, askedAt);
      // The control: at the hook's first listing there is no request of this session, as measured.
      expect(sessionStartCardSlotForRequest(sessionId, 'startup', terminal(), hookListsAt)).toBeUndefined();

      const slotFile = await awaitSessionStartCardSlotForRequest(sessionId, 'startup', terminal(), clock);

      // A poll, not one sleep: the request is answered at the first listing after it is written.
      const answeredAt = hookListsAt + Math.ceil(requestIsLateByMs / SESSION_START_CARD_REQUEST_HOOK_POLL_EVERY_MS) * SESSION_START_CARD_REQUEST_HOOK_POLL_EVERY_MS;
      expect(new Set(clock.sleeps)).toEqual(new Set([SESSION_START_CARD_REQUEST_HOOK_POLL_EVERY_MS]));
      expect([requestIsLateByMs, clock.nowEpochMs]).toEqual([requestIsLateByMs, answeredAt]);
      expect(slotFile).toBe(sessionStartCardSlotPath(pluginDataDirectory, sessionId, answeredAt));

      // The card's look, 200 ms after it asked or later, finds the slot the hook then writes.
      expect(writeSessionStartCardSlot(slotFile!, sessionId, 'banner', pluginDataDirectory, answeredAt)).toBe(true);
      expect(newestSessionStartCardSlotSince(readdirSync(slotFolder), sessionId, askedAt)).toEqual({
        fileName: `${sessionId}.${answeredAt}.json`,
        clockEpochMs: answeredAt,
      });
    }
  });

  it('answers a request that is there at the first listing without any wait', async () => {
    cardAsks(SESSION_ID, hookListsAt - 30);
    const clock = clockWhereTheCardWritesAt(null);
    expect(await awaitSessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), clock))
      .toBe(sessionStartCardSlotPath(pluginDataDirectory, SESSION_ID, hookListsAt));
    expect(clock.sleeps).toEqual([]);
  });

  it('does not wait where no card has ever asked: no slot folder, or a folder without a request', async () => {
    // No slot folder: Claude Code without the card, or claude-mem's first start.
    let clock = clockWhereTheCardWritesAt(hookListsAt + 5);
    expect(await awaitSessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), clock)).toBeUndefined();
    expect(clock.sleeps).toEqual([]);

    // Slots, and a file that is no request: an account whose card names its file in the event leaves these.
    mkdirSync(slotFolder, { recursive: true });
    writeFileSync(sessionStartCardSlotPath(pluginDataDirectory, 'an-earlier-session', hookListsAt - 60_000), '{"text":"banner"}');
    writeFileSync(path.join(slotFolder, 'notes.request.txt'), '');
    clock = clockWhereTheCardWritesAt(hookListsAt + 5);
    expect(await awaitSessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), clock)).toBeUndefined();
    expect(clock.sleeps).toEqual([]);
  });

  it('does not wait for a start no card asks at, even where a card has asked before', async () => {
    cardAsks('an-earlier-session', hookListsAt - 60_000);
    const waitsFor = async (sessionId: string | undefined, source: string | undefined, environment: Record<string, string | undefined>) => {
      const clock = clockWhereTheCardWritesAt(null);
      expect(await awaitSessionStartCardSlotForRequest(sessionId, source, environment, clock)).toBeUndefined();
      return clock.sleeps.length;
    };
    // The control: a startup on the terminal waits the whole wait here.
    expect(await waitsFor(SESSION_ID, 'startup', terminal())).toBeGreaterThan(0);

    // session.start does not come with a /clear or a compaction.
    for (const source of ['clear', 'compact', 'resume', undefined]) {
      expect([source, await waitsFor(SESSION_ID, source, terminal())]).toEqual([source, 0]);
    }
    // The Claude app, VS Code and a `-p` run: the card draws on the terminal's own screen only.
    for (const entrypoint of ['sdk-cli', 'claude-desktop', 'claude-vscode', undefined]) {
      expect([entrypoint, await waitsFor(SESSION_ID, 'startup', { ...terminal(), CLAUDE_CODE_ENTRYPOINT: entrypoint })]).toEqual([entrypoint, 0]);
    }
    for (const dataDirectory of [undefined, '']) {
      expect([dataDirectory, await waitsFor(SESSION_ID, 'startup', { ...terminal(), CLAUDE_PLUGIN_DATA: dataDirectory })]).toEqual([dataDirectory, 0]);
    }
    for (const sessionId of [undefined, '', '../another-session']) {
      expect([sessionId, await waitsFor(sessionId, 'startup', terminal())]).toEqual([sessionId, 0]);
    }
    // A request of this session that has run out: the card has stopped looking, and writes no second one.
    cardAsks(SESSION_ID, hookListsAt - SESSION_START_CARD_REQUEST_WAIT_MS);
    expect(await waitsFor(SESSION_ID, 'startup', terminal())).toBe(0);
  });

  it('waits no longer than its limit, and then names nothing, so the whole banner stays the hook message', async () => {
    cardAsks('an-earlier-session', hookListsAt - 60_000);
    // The card's request lands one poll after the limit.
    const clock = clockWhereTheCardWritesAt(hookListsAt + SESSION_START_CARD_REQUEST_HOOK_WAIT_MS + SESSION_START_CARD_REQUEST_HOOK_POLL_EVERY_MS);

    expect(await awaitSessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), clock)).toBeUndefined();
    expect(clock.nowEpochMs - hookListsAt).toBe(SESSION_START_CARD_REQUEST_HOOK_WAIT_MS);
    expect(clock.sleeps).toHaveLength(SESSION_START_CARD_REQUEST_HOOK_WAIT_MS / SESSION_START_CARD_REQUEST_HOOK_POLL_EVERY_MS);

    // The control: a request written at the limit's last poll is still answered.
    const lastPollClock = clockWhereTheCardWritesAt(hookListsAt + SESSION_START_CARD_REQUEST_HOOK_WAIT_MS);
    expect(await awaitSessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), lastPollClock)).toBeDefined();
  });

  it('ends its wait by its clock and by the count of its sleeps, whichever comes first', async () => {
    cardAsks('an-earlier-session', hookListsAt - 60_000);
    const wholeWait = SESSION_START_CARD_REQUEST_HOOK_WAIT_MS / SESSION_START_CARD_REQUEST_HOOK_POLL_EVERY_MS;
    const sleepsWhereEachSleepMovesTheClockBy = async (clockMovesByMs: number) => {
      const clock = clockWhereTheCardWritesAt(null);
      const countsTheSleep = clock.sleep;
      clock.sleep = async () => {
        await countsTheSleep(clockMovesByMs);
      };
      expect(await awaitSessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), clock)).toBeUndefined();
      return clock.sleeps.length;
    };
    // A busy machine, where a sleep of 10 ms takes 25: the clock ends the wait at its limit.
    expect(await sleepsWhereEachSleepMovesTheClockBy(25)).toBe(SESSION_START_CARD_REQUEST_HOOK_WAIT_MS / 25);
    // A clock that stands still, and one that is set back: the count of sleeps ends the wait.
    expect(await sleepsWhereEachSleepMovesTheClockBy(0)).toBe(wholeWait);
    expect(await sleepsWhereEachSleepMovesTheClockBy(-1000)).toBe(wholeWait);
  });

  it('stops waiting on a host whose card no longer asks: a wait that runs out deletes requests older than an hour', async () => {
    const waits = async () => {
      const clock = clockWhereTheCardWritesAt(null);
      expect(await awaitSessionStartCardSlotForRequest(SESSION_ID, 'startup', terminal(), clock)).toBeUndefined();
      return clock.sleeps.length;
    };
    const wholeWait = SESSION_START_CARD_REQUEST_HOOK_WAIT_MS / SESSION_START_CARD_REQUEST_HOOK_POLL_EVERY_MS;
    // A request left by a Claude Code that had the card, 59 minutes ago: kept, so the next start waits again.
    const leftRequest = cardAsks('an-earlier-session', hookListsAt - 59 * 60_000);
    const youngEnough = (hookListsAt - 59 * 60_000) / 1000;
    utimesSync(leftRequest, youngEnough, youngEnough);
    expect(await waits()).toBe(wholeWait);
    expect(existsSync(leftRequest)).toBe(true);
    expect(await waits()).toBe(wholeWait);

    // The same request, now older than an hour: the wait that runs out deletes it, and the start after it does not wait.
    const tooOld = (hookListsAt - SESSION_START_CARD_SLOT_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(leftRequest, tooOld, tooOld);
    expect(await waits()).toBe(wholeWait);
    expect(existsSync(leftRequest)).toBe(false);
    expect(await waits()).toBe(0);
  });
});
