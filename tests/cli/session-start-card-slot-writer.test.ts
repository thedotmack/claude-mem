import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  SESSION_START_CARD_SLOT_MAX_AGE_MS,
  writeSessionStartCardSlot,
} from '../../src/cli/session-start-card-slot-writer.js';
import { sessionStartCardLines } from '../../src/mods/session-start-card/card.js';
import { SESSION_START_CARD_FOLDER, sessionStartCardSlotPath } from '../../src/shared/session-start-card-slot.js';

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
});
