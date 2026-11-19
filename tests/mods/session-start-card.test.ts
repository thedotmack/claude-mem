import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { colors } from '../../src/services/context/types.js';
import {
  isSessionStartCardSource,
  parseAnsiLines,
  sessionStartCardLines,
  supportsSessionStartCard,
} from '../../src/mods/session-start-card/card.js';
import type { On } from '../../src/mods/session-start-card/mod-api.js';
import { registerSessionStartCard } from '../../src/mods/session-start-card/register.js';
import {
  isSessionStartCardSlotFileName,
  isSessionStartCardSlotFileNameOf,
  SESSION_START_CARD_FILE_KEY,
  SESSION_START_CARD_SOURCES,
  sessionStartCardSlotPath,
} from '../../src/shared/session-start-card-slot.js';

const plain = { color: undefined, isBold: false, isDim: false };

describe('session-start card: the banner as styled lines', () => {
  it('draws every code the context renderer colors the banner with', () => {
    const expectedStyles: Record<keyof typeof colors, object> = {
      reset: plain,
      bright: { ...plain, isBold: true },
      dim: { ...plain, isDim: true },
      cyan: { ...plain, color: 'cyan' },
      green: { ...plain, color: 'green' },
      yellow: { ...plain, color: 'yellow' },
      blue: { ...plain, color: 'blue' },
      magenta: { ...plain, color: 'magenta' },
      gray: { ...plain, color: 'gray' },
      red: { ...plain, color: 'red' },
    };
    // A color added to the renderer fails here until the card can draw it.
    expect(Object.keys(expectedStyles).sort()).toEqual(Object.keys(colors).sort());
    for (const [name, code] of Object.entries(colors)) {
      const [[styled, afterReset]] = parseAnsiLines(`${code}styled${colors.reset}after`);
      expect(styled).toEqual({ text: 'styled', ...expectedStyles[name as keyof typeof colors] });
      expect(afterReset).toEqual({ text: 'after', ...plain });
    }
  });

  it('splits a timeline row into its runs and keeps blank lines', () => {
    const row = `  ${colors.dim}#241301${colors.reset}  ${colors.dim}11:55a${colors.reset}  ${colors.bright}${colors.cyan}Test suite survey${colors.reset}`;
    expect(parseAnsiLines(`${row}\n\nplain line`)).toEqual([
      [
        { text: '  ', ...plain },
        { text: '#241301', ...plain, isDim: true },
        { text: '  ', ...plain },
        { text: '11:55a', ...plain, isDim: true },
        { text: '  ', ...plain },
        { text: 'Test suite survey', color: 'cyan', isBold: true, isDim: false },
      ],
      [],
      [{ text: 'plain line', ...plain }],
    ]);
  });

  it('keeps a style across a line break until it is reset, as a terminal does', () => {
    expect(parseAnsiLines(`${colors.red}first\r\nsecond${colors.reset}\nthird`)).toEqual([
      [{ text: 'first', ...plain, color: 'red' }],
      [{ text: 'second', ...plain, color: 'red' }],
      [{ text: 'third', ...plain }],
    ]);
  });

  it('takes out every character Claude Code refuses in drawn text, since one makes it skip the row', () => {
    const refused = '\x00\x07\x08\x0b\x0c\x0e\x1b\x1f\x7f\x85\x9f\uD83D\u{10EEEE}';
    const [[run]] = parseAnsiLines(`a${refused}b\tc 😀 ⠀d`);
    // Tab, an emoji (a surrogate pair) and ordinary text stay; a braille blank draws as a space.
    expect(run.text).toBe('ab\tc 😀  d');
    expect(parseAnsiLines(refused)).toEqual([[]]);
  });

  it('reads a slot file, and draws nothing from one that holds no banner', () => {
    expect(sessionStartCardLines(JSON.stringify({ text: 'one\ntwo' }))).toEqual([
      [{ text: 'one', ...plain }],
      [{ text: 'two', ...plain }],
    ]);
    for (const notABanner of ['', '{', 'null', '[]', '{}', '{"text":42}', '{"text":"  \\n "}']) {
      expect(sessionStartCardLines(notABanner)).toBeNull();
    }
  });
});

describe('session-start card: which sessions get one', () => {
  it('draws from Claude Code 2.1.326 on, the first with every call it makes', () => {
    for (const version of ['2.1.326', '2.1.326-dev.20261101', '2.1.327', '2.2.0', '3.0.0', '10.0.1']) {
      expect(supportsSessionStartCard(version)).toBe(true);
    }
    for (const version of ['2.1.325', '2.1.314', '2.1.312', '2.1.287', '2.0.999', '1.9.999', '', 'latest', undefined]) {
      expect(supportsSessionStartCard(version)).toBe(false);
    }
  });

  it('follows exactly the sources the context hook runs on', () => {
    const { hooks } = JSON.parse(readFileSync(new URL('../../plugin/hooks/hooks.json', import.meta.url), 'utf-8')) as {
      hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ args?: string[] }> }> };
    };
    const contextGroup = hooks.SessionStart.find(group => group.hooks.some(hook => hook.args?.join(' ') === 'hook claude-code context'));
    expect(contextGroup!.matcher.split('|').sort()).toEqual([...SESSION_START_CARD_SOURCES].sort());
    for (const source of SESSION_START_CARD_SOURCES) expect(isSessionStartCardSource(source)).toBe(true);
    for (const source of ['resume', 'fork', '', undefined, 42]) expect(isSessionStartCardSource(source)).toBe(false);
  });

  it('names one slot file per session start, and tells one session\'s from another\'s', () => {
    const slotPath = sessionStartCardSlotPath('/data/claude-mem//', '0b6f6e0c-11aa-4c1e-9d5e-2f3b6a7c8d9e', 1794888786050);
    expect(slotPath).toBe('/data/claude-mem/session-start-card/0b6f6e0c-11aa-4c1e-9d5e-2f3b6a7c8d9e.1794888786050.json');

    expect(isSessionStartCardSlotFileNameOf('abc-123.42.json', 'abc-123')).toBe(true);
    expect(isSessionStartCardSlotFileName('abc-123.42.json')).toBe(true);
    for (const [fileName, sessionId] of [
      ['abc-123.42.json', 'abc'],
      ['abc-123.42.json', 'abc-1234'],
      ['abc-123.42.json.tmp', 'abc-123'],
      ['abc-123.4x2.json', 'abc-123'],
      ['abc-123..json', 'abc-123'],
      ['abc-123.1.2.json', 'abc-123'],
      ['../abc-123.42.json', 'abc-123'],
      ['sub/abc-123.42.json', 'abc-123'],
      ['a.b.42.json', 'a.b'],
    ]) {
      expect(isSessionStartCardSlotFileNameOf(fileName, sessionId)).toBe(false);
    }
    for (const fileName of ['settings.json', 'abc-123.json', '.42.json', 'abc 123.42.json']) {
      expect(isSessionStartCardSlotFileName(fileName)).toBe(false);
    }
  });
});

type Hook = ($: unknown, e: any, next: (e: any) => Promise<unknown>) => Promise<unknown>;

/** What the fake element factory builds: enough to read a drawing back. */
interface DrawnNode {
  element: string;
  props: Record<string, unknown> | null;
  children: unknown[];
}

function drawnText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(drawnText).join('');
  return (node as DrawnNode).children.map(drawnText).join('');
}

/**
 * The card's hooks under a stand-in for Claude Code: `next` at SessionStart
 * plays the command hooks, so `writeSlot` is what the context hook does with
 * the file the card named, and `hookRowsKept` is Claude Code keeping the last
 * row of that start's hooks once the SessionStart hooks have returned.
 */
function cardInSession(options: {
  entrypoint?: string;
  version?: { version: string; base?: string } | 'throws';
  hookEnv?: 'throws';
  pluginDataDirectory?: string;
  placeResult?: () => unknown;
} = {}) {
  const hooks = new Map<string, Hook>();
  const matchers = new Map<string, unknown>();
  registerSessionStartCard(((event: string, ...rest: unknown[]) => {
    hooks.set(event, rest.at(-1) as Hook);
    if (rest.length > 1) matchers.set(event, rest[0]);
    return { catch() {} };
  }) as unknown as On);

  const files = new Map<string, string>();
  const record = { placedRowIds: [] as string[], logs: [] as string[], invalidations: 0, eventsSentOn: [] as any[], hookEnvCalls: 0 };
  let clockMs = 1_000;
  let keptRowCount = 0;
  const $ = {
    plugin: { name: 'claude-mem' },
    env: { get: async (name: string) => (name === 'CLAUDE_CODE_ENTRYPOINT' ? options.entrypoint ?? 'cli' : undefined) },
    fs: {
      exists: async (filePath: string) => files.has(filePath),
      read: async (filePath: string) => files.get(filePath)!,
    },
    session: {
      version: async () => {
        if (options.version === 'throws') throw new TypeError('$.session.version is not a function');
        return options.version ?? { version: '2.1.326' };
      },
    },
    process: {
      hookEnv: async () => {
        record.hookEnvCalls += 1;
        if (options.hookEnv === 'throws') throw new Error('EACCES: could not make the plugin data folder');
        return 'pluginDataDirectory' in options ? { CLAUDE_PLUGIN_DATA: options.pluginDataDirectory } : { CLAUDE_PLUGIN_DATA: '/data/claude-mem' };
      },
    },
    clock: { now: async () => clockMs },
    ui: {
      place: async (row: { id: string }) => {
        record.placedRowIds.push(row.id);
        return options.placeResult ? options.placeResult() : { isPlaced: true, requestId: `request-${row.id}` };
      },
      invalidate: () => { record.invalidations += 1; },
      log: (text: string) => { record.logs.push(text); },
      resolve: () => ({ Box: 'Box', Text: 'Text', Raster: 'Raster' }),
    },
  };

  return {
    record,
    files,
    matchers,
    /** A SessionStart of `source`; `writeSlot` is the banner the context hook writes, or null when it writes none. */
    async classicSessionStart(source: string, writeSlot: string | null, sessionId: unknown = 'session-1') {
      const event = { session_id: sessionId, source, hook_event_name: 'SessionStart' };
      const result = await hooks.get('classic.SessionStart')!($, event, async sent => {
        record.eventsSentOn.push(sent);
        const slotFile = sent[SESSION_START_CARD_FILE_KEY];
        if (slotFile && writeSlot !== null) files.set(slotFile, writeSlot);
        return { additionalContext: ['context'] };
      });
      expect(result).toEqual({ additionalContext: ['context'] });
      return event;
    },
    /** Claude Code keeps the combined-context row of the latest start's hooks; the hook relays the kept row unchanged. */
    async hookRowsKept() {
      keptRowCount += 1;
      const keptRow = { message: { type: 'attachment', name: 'hook_additional_context', content: [] }, uuid: `row-${keptRowCount}` };
      const relayed = await hooks.get('session.append')!(
        $,
        { ...keptRow, door: 'hook-context', origin: { kind: 'hook', event: 'SessionStart' } },
        async appended => ({ message: appended.message, uuid: appended.uuid }),
      );
      expect(relayed).toEqual(keptRow);
    },
    /** A drawing of a placed row; `isFullscreen` is what the surface's viewport says, left out where it says nothing. */
    async render(id: string, plugin = 'claude-mem', where: { surface?: string; isFullscreen?: boolean; columns?: number; rows?: number } = {}) {
      const { surface = 'terminal', ...dimensions } = where;
      const viewport = Object.keys(dimensions).length ? dimensions : undefined;
      return hooks.get('ui.render')!($, { surface, viewport, props: { id, plugin } }, async () => 'not this card');
    },
    advanceClock(ms: number) { clockMs += ms; },
  };
}

describe('session-start card: the hooks', () => {
  const realH = (globalThis as { h?: unknown }).h;
  beforeAll(() => {
    (globalThis as { h?: unknown }).h = (element: string, props: Record<string, unknown> | null, ...children: unknown[]): DrawnNode => ({ element, props, children });
  });
  afterAll(() => {
    (globalThis as { h?: unknown }).h = realH;
  });

  const slot = (text: string) => JSON.stringify({ text });
  const reason = 'claude-mem: the session-start card is not shown: ';

  it('names a file for the banner only where the card can draw, and passes every other start on untouched', async () => {
    const here = cardInSession();
    const event = await here.classicSessionStart('startup', null);
    expect(here.record.eventsSentOn).toEqual([{ ...event, [SESSION_START_CARD_FILE_KEY]: '/data/claude-mem/session-start-card/session-1.1000.json' }]);

    const untouched: Array<[string, ReturnType<typeof cardInSession>, string, unknown?]> = [
      ['a resumed session', cardInSession(), 'resume'],
      ['a forked session', cardInSession(), 'fork'],
      ['a -p run', cardInSession({ entrypoint: 'sdk-cli' }), 'startup'],
      ['the Desktop app', cardInSession({ entrypoint: 'claude-desktop' }), 'startup'],
      ['a Claude Code older than the card needs', cardInSession({ version: { version: '2.1.325' } }), 'startup'],
      ['a session id that cannot name a file', cardInSession(), 'startup', '../../etc/passwd'],
      ['a compaction before any drawing said the layout', cardInSession(), 'compact'],
    ];
    for (const [name, session, source, sessionId] of untouched) {
      const sent = await session.classicSessionStart(source, slot('banner'), sessionId ?? 'session-1');
      await session.hookRowsKept();
      expect([name, session.record.eventsSentOn]).toEqual([name, [sent]]);
      expect(session.record.eventsSentOn[0]).toBe(sent);
      expect([name, session.record.placedRowIds, session.record.logs]).toEqual([name, [], []]);
    }
  });

  it('says why, in one line, when it cannot name a file, and passes the start on untouched so the hook sends the whole banner', async () => {
    const failures: Array<[string, ReturnType<typeof cardInSession>, string]> = [
      ['the version call fails', cardInSession({ version: 'throws' }), `${reason}$.session.version is not a function`],
      ['the hook-environment call fails', cardInSession({ hookEnv: 'throws' }), `${reason}EACCES: could not make the plugin data folder`],
      ['Claude Code names no plugin data folder', cardInSession({ pluginDataDirectory: undefined }), `${reason}Claude Code named no plugin data folder`],
    ];
    for (const [name, session, line] of failures) {
      const sent = await session.classicSessionStart('startup', slot('banner'));
      expect([name, session.record.eventsSentOn]).toEqual([name, [sent]]);
      expect(session.record.eventsSentOn[0]).toBe(sent);
      // The line waits for the start's hook rows, like the card: said any earlier, it keeps them off the main screen.
      expect([name, session.record.logs]).toEqual([name, []]);
      await session.hookRowsKept();
      expect([name, session.record.placedRowIds, session.record.logs]).toEqual([name, [], [line]]);
    }
  });

  it('goes by the version a build is based on', async () => {
    const devBuild = cardInSession({ version: { version: '0.0.0-dev', base: '2.1.326' } });
    await devBuild.classicSessionStart('startup', null);
    expect(devBuild.record.eventsSentOn[0][SESSION_START_CARD_FILE_KEY]).toBeDefined();
  });

  it('never makes the hook-environment call on a Claude Code that lacks it', async () => {
    const olderBuild = cardInSession({ version: { version: '2.1.325' } });
    await olderBuild.classicSessionStart('startup', null);
    expect(olderBuild.record.hookEnvCalls).toBe(0);

    const firstBuildWithIt = cardInSession({ version: { version: '2.1.326' } });
    await firstBuildWithIt.classicSessionStart('startup', null);
    expect(firstBuildWithIt.record.hookEnvCalls).toBe(1);
  });

  it('waits for the combined-context row of the SessionStart hooks, the last row Claude Code keeps for them', () => {
    expect(cardInSession().matchers.get('session.append')).toEqual({
      door: 'hook-context',
      origin: { kind: 'hook', event: 'SessionStart' },
      message: { name: 'hook_additional_context' },
    });
  });

  it('places the card once Claude Code has kept the start\'s last hook row, and draws the banner in a frame', async () => {
    const session = cardInSession();
    await session.classicSessionStart('startup', slot(`${colors.dim}Access Claude-Mem Rules + Tools${colors.reset}\n\n  ${colors.cyan}#12${colors.reset}  newest row`));
    expect(session.record.placedRowIds).toEqual([]);
    await session.hookRowsKept();
    expect(session.record.placedRowIds).toEqual(['session-start-1000']);
    expect(session.record.logs).toEqual([]);

    const drawing = await session.render('session-start-1000') as DrawnNode;
    expect(drawing.element).toBe('Box');
    expect(drawing.props).toMatchObject({ borderStyle: 'round', flexDirection: 'column' });
    const [title, lines] = drawing.children as [DrawnNode, DrawnNode[]];
    expect(drawnText(title)).toBe('claude-mem');
    expect(lines.map(drawnText)).toEqual(['Access Claude-Mem Rules + Tools', ' ', '  #12  newest row']);
    const [dimRun] = lines[0].children[0] as DrawnNode[];
    expect(dimRun.props).toMatchObject({ dimColor: true });
    const [, cyanRun] = lines[2].children[0] as DrawnNode[];
    expect(cyanRun.props).toMatchObject({ color: 'cyan' });
  });

  it('draws the right-hand mark at terminal widths that leave room for the banner', async () => {
    const session = cardInSession();
    await session.classicSessionStart('startup', slot(`first line\n\n${colors.cyan}last line${colors.reset}`));
    await session.hookRowsKept();
    const row = 'session-start-1000';
    const original = await session.render(row) as DrawnNode;

    for (const [columns, viewportRows, width, height] of [
      [64, 11, 14, 7], [99, 24, 14, 7], [100, 15, 14, 7],
      [100, 16, 24, 12], [160, undefined, 24, 12],
    ] as const) {
      const drawing = await session.render(row, 'claude-mem', { columns, rows: viewportRows }) as DrawnNode;
      expect(drawing.props).toMatchObject({ flexDirection: 'column', borderStyle: 'round', borderColor: 'claude' });
      const [header] = drawing.children as DrawnNode[];
      expect(header.props).toMatchObject({ flexDirection: 'row', columnGap: 2 });
      const [copy, mark] = header.children as DrawnNode[];
      expect(copy.props).toMatchObject({ minWidth: 0, flexGrow: 1 });
      expect(copy.children).toEqual(original.children);
      expect(mark.props).toMatchObject({ width, flexShrink: 0, alignSelf: 'center' });
      const [raster] = mark.children as DrawnNode[];
      expect(raster.element).toBe('Raster');
      expect(raster.props).toMatchObject({ columns: width, rows: height, key: 'brand-mark' });
      expect(drawnText(mark)).toBe('');
      const bytes = Buffer.from(raster.props!.cells as string, 'base64');
      expect(bytes.length).toBe(width * height * 12);
      const glyphs = [];
      for (let cell = 0; cell < bytes.length; cell += 12) {
        glyphs.push(String.fromCharCode(bytes.readUInt32LE(cell)));
        expect(bytes.readUInt32LE(cell + 4)).toBe(0xd86441);
        expect(bytes.readUInt32LE(cell + 8)).toBe(0x01000000);
      }
      expect(glyphs.join('')).toMatch(/^[ \u2801-\u28ff]+$/u);
      expect(glyphs).toContain('⣿');
    }
    expect(await session.render(row, 'claude-mem', { columns: 63 })).toEqual(original);
    expect(await session.render(row, 'claude-mem', { columns: 118, rows: 10 })).toEqual(original);
    expect(await session.render(row, 'claude-mem', { columns: 120, surface: 'desktop' })).toEqual(original);
    expect(session.record.placedRowIds).toEqual([row]);
  });

  it('keeps the mark near the top and gives the rest of a long timeline the full width', async () => {
    const session = cardInSession();
    const history = Array.from({ length: 80 }, (_, i) => `#${i} 🔎 追跡 · src/services/context/render.ts`);
    await session.classicSessionStart('startup', slot(history.join('\n')));
    await session.hookRowsKept();
    const drawing = await session.render('session-start-1000', 'claude-mem', { columns: 80, rows: 24 }) as DrawnNode;
    const [header, fullWidth] = drawing.children as [DrawnNode, DrawnNode[]];
    const [copy] = header.children as DrawnNode[];
    const [, besideMark] = copy.children as [DrawnNode, DrawnNode[]];
    expect(besideMark.map(drawnText)).toEqual(history.slice(0, 15));
    expect(fullWidth.map(drawnText)).toEqual(history.slice(15));
  });

  it('places a start\'s card once, and nothing for a start a later one overtook', async () => {
    const session = cardInSession();
    await session.classicSessionStart('startup', slot('banner'));
    await session.hookRowsKept();
    await session.hookRowsKept();
    expect(session.record.placedRowIds).toEqual(['session-start-1000']);

    // A start whose rows never came is not the next start's to show: a resume names no file.
    const overtaken = cardInSession();
    await overtaken.classicSessionStart('startup', slot('banner'));
    await overtaken.classicSessionStart('resume', null);
    await overtaken.hookRowsKept();
    expect([overtaken.record.placedRowIds, overtaken.record.logs]).toEqual([[], []]);
  });

  it('leaves every other placed row to whoever placed it', async () => {
    const session = cardInSession();
    expect(await session.render('session-start-1000')).toBe('not this card');
    await session.classicSessionStart('startup', slot('banner'));
    await session.hookRowsKept();
    expect(await session.render('session-start-1000', 'another-plugin')).toBe('not this card');
    expect(await session.render('some-other-row')).toBe('not this card');
  });

  it('draws a new card after /clear and stops drawing the old one', async () => {
    const session = cardInSession();
    await session.classicSessionStart('startup', slot('first banner'));
    await session.hookRowsKept();
    session.advanceClock(5_000);
    await session.classicSessionStart('clear', slot('second banner'), 'session-2');
    await session.hookRowsKept();
    expect(session.record.eventsSentOn[1][SESSION_START_CARD_FILE_KEY]).toBe('/data/claude-mem/session-start-card/session-2.6000.json');
    expect(session.record.placedRowIds).toEqual(['session-start-1000', 'session-start-6000']);
    expect(await session.render('session-start-1000')).toBe('not this card');
    expect(drawnText(await session.render('session-start-6000'))).toBe('claude-memsecond banner');
    // The old row is asked again, so it stops drawing the first banner.
    expect(session.record.invalidations).toBe(2);
  });

  it('draws nothing and says nothing when the context hook wrote no file: it sent its own message', async () => {
    const session = cardInSession();
    await session.classicSessionStart('startup', null);
    await session.hookRowsKept();
    expect(session.record.placedRowIds).toEqual([]);
    expect(session.record.logs).toEqual([]);
  });

  it('keeps drawing the card before it when a compaction sends no banner: the kept history shows it like any earlier row', async () => {
    const session = cardInSession();
    await session.render('any-row', 'another-plugin', { isFullscreen: true });
    await session.classicSessionStart('startup', slot('first banner'));
    await session.hookRowsKept();
    // The worker did not answer in time, or the terminal output was turned off: the context hook wrote no file.
    session.advanceClock(5_000);
    await session.classicSessionStart('compact', null);
    expect([session.record.placedRowIds, session.record.logs, session.record.invalidations]).toEqual([['session-start-1000'], [], 1]);
    expect(drawnText(await session.render('session-start-1000', 'claude-mem', { isFullscreen: true }))).toBe('claude-memfirst banner');
  });

  it('says so, once, when the banner cannot be shown, and keeps drawing the card before it', async () => {
    let placeAnswer: unknown = { isPlaced: true, requestId: 'r0' };
    const session = cardInSession({ placeResult: () => placeAnswer });
    await session.classicSessionStart('startup', slot('first banner'));
    await session.hookRowsKept();
    placeAnswer = { isPlaced: false, reason: 'no conversation to place a row in' };
    session.advanceClock(5_000);
    await session.classicSessionStart('clear', slot('second banner'), 'session-2');
    await session.hookRowsKept();
    expect(session.record.logs).toEqual([`${reason}no conversation to place a row in`]);
    expect(drawnText(await session.render('session-start-1000'))).toBe('claude-memfirst banner');

    const unreadable = cardInSession();
    await unreadable.classicSessionStart('startup', '{"text":');
    expect(unreadable.record.logs).toEqual([]);
    await unreadable.hookRowsKept();
    expect(unreadable.record.placedRowIds).toEqual([]);
    expect(unreadable.record.logs).toEqual([`${reason}/data/claude-mem/session-start-card/session-1.1000.json holds no banner`]);
  });

  it('counts a row that stands with no screen drawing it yet as placed', async () => {
    const session = cardInSession({ placeResult: () => ({ isPlaced: false, requestId: 'r1', reason: 'no attached surface draws placed rows yet' }) });
    await session.classicSessionStart('startup', slot('banner'));
    await session.hookRowsKept();
    expect(session.record.logs).toEqual([]);
  });

  it('gives a compaction a card, placed at once, only once a terminal drawing said fullscreen', async () => {
    const mainScreen = cardInSession();
    await mainScreen.render('any-row', 'another-plugin', { isFullscreen: false });
    const sentOnMainScreen = await mainScreen.classicSessionStart('compact', slot('banner'));
    expect(mainScreen.record.eventsSentOn[0]).toBe(sentOnMainScreen);

    const otherSurface = cardInSession();
    await otherSurface.render('any-row', 'another-plugin', { surface: 'desktop', isFullscreen: true });
    const sentOnOtherSurface = await otherSurface.classicSessionStart('compact', slot('banner'));
    expect(otherSurface.record.eventsSentOn[0]).toBe(sentOnOtherSurface);

    // Any plugin's row drawn on the fullscreen terminal says so, the card's own included.
    const fullscreen = cardInSession();
    await fullscreen.render('any-row', 'another-plugin', { isFullscreen: true });
    await fullscreen.classicSessionStart('compact', slot('compacted banner'));
    expect(fullscreen.record.eventsSentOn[0][SESSION_START_CARD_FILE_KEY]).toBe('/data/claude-mem/session-start-card/session-1.1000.json');
    // No row comes after a compaction's hook rows, so the card does not wait for one.
    expect(fullscreen.record.placedRowIds).toEqual(['session-start-1000']);
    expect(drawnText(await fullscreen.render('session-start-1000', 'claude-mem', { isFullscreen: true }))).toBe('claude-memcompacted banner');
    await fullscreen.hookRowsKept();
    expect([fullscreen.record.placedRowIds, fullscreen.record.logs]).toEqual([['session-start-1000'], []]);

    // A later drawing on the main screen sends compactions back to the whole message.
    await fullscreen.render('session-start-1000', 'claude-mem', { isFullscreen: false });
    fullscreen.advanceClock(5_000);
    await fullscreen.classicSessionStart('compact', slot('banner'));
    expect(Object.keys(fullscreen.record.eventsSentOn[1]).includes(SESSION_START_CARD_FILE_KEY)).toBe(false);
  });

  it('says at once why a compaction on the fullscreen layout has no card', async () => {
    const session = cardInSession({ placeResult: () => ({ isPlaced: false, reason: 'a plugin holds at most 500 placed rows' }) });
    await session.render('any-row', 'another-plugin', { isFullscreen: true });
    await session.classicSessionStart('compact', slot('banner'));
    expect(session.record.logs).toEqual([`${reason}a plugin holds at most 500 placed rows`]);
  });
});
