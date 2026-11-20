import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
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
