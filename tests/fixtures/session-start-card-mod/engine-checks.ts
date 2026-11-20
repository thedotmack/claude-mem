// Claude Code test-kit checks for the session-start card (run by `claude plugin test`,
// not bun). tests/integration/hooks-module-engine.test.ts copies this file into a
// scratch plugin's tests/ folder, next to the bundled hooks module. They need the
// first Claude Code with every call the card makes (2.1.326 or later). Each stub
// answers in Claude Code's place: its version, the session's id, the hook
// environment, files, and the placing of a row.
import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'hooks-module-engine-test'
const SLOT_FILE_KEY = 'claude_mem_session_start_card_file'
const BANNER = '\x1b[2mAccess Claude-Mem Rules + Tools\x1b[0m\n\n  \x1b[36m#12\x1b[0m  \x1b[1mnewest row\x1b[0m'
const NOT_SHOWN = 'claude-mem: the session-start card is not shown: '
const SLOT_FOLDER = '/data/claude-mem/session-start-card'

function stubs(on: any, options: { entrypoint?: string; version?: string; hookEnv?: () => unknown; banner?: string | null; placed?: () => unknown } = {}) {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { HOME: '/home/ada', CLAUDE_CODE_ENTRYPOINT: options.entrypoint ?? 'cli' })
  // `notes` are the lines in the transcript; `debugNotes` went to the debug log alone.
  const record = { sentOn: [] as any[], placedRowIds: [] as string[], notes: [] as string[], debugNotes: [] as string[], listings: 0 }
  const files = new Map<string, string>()
  on('session.version', () => ({ value: { version: options.version ?? '2.1.326', base: options.version ?? '2.1.326' } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('process.hookEnv', () => (options.hookEnv ? options.hookEnv() : { value: { CLAUDE_PLUGIN_DATA: '/data/claude-mem' } }))
  on('fs.exists', ($: any, e: any) => ({ value: files.has(e.path) }))
  on('fs.read', ($: any, e: any) => (files.has(e.path) ? { value: files.get(e.path) } : { deny: 'missing' }))
  on('fs.write', ($: any, e: any) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.list', ($: any, e: any) => {
    record.listings += 1
    const inFolder = [...files.keys()].filter(path => path.startsWith(`${e.path}/`))
    return { value: inFolder.map(path => ({ name: path.slice(e.path.length + 1), kind: 'file', size: files.get(path)!.length, mtimeMs: 0.5, isLink: false })) }
  })
  on('ui.place', ($: any, e: any) => {
    record.placedRowIds.push(e.id)
    return { value: options.placed ? options.placed() : { isPlaced: true, requestId: `request-${e.id}` } }
  })
  on('ui.log', ($: any, e: any) => { (e.to === 'debug' ? record.debugNotes : record.notes).push(e.text); return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }))
  // The SessionStart command hooks: the context hook writes the banner to the file the card named.
  on('classic.SessionStart', ($: any, e: any) => {
    record.sentOn.push(e)
    if (e[SLOT_FILE_KEY] && options.banner !== null) files.set(e[SLOT_FILE_KEY], JSON.stringify({ text: options.banner ?? BANNER }))
    return { additionalContext: ['the timeline'] }
  })
  return { clock, record, files }
}

const startup = { session_id: 'session-1', source: 'startup', hook_event_name: 'SessionStart', cwd: '/work', transcript_path: '/work/t.jsonl' }
const terminalSession = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const cardRow = (id: string) => ({ plugin: PLUGIN, surface: 'terminal', component: 'Placed', props: { id, plugin: PLUGIN } }) as const
const onLayout = (isFullscreen: boolean) => ({ viewport: { columns: 120, rows: 40, isFullscreen } })

let keptRowCount = 0
/** A row of a session start's hooks, as Claude Code keeps it after the SessionStart hooks returned. */
function hookRowKept($: any, options: { name?: string; event?: string } = {}) {
  keptRowCount += 1
  return $.session.append({
    message: { type: 'attachment', name: options.name ?? 'hook_additional_context', content: [{ type: 'text', text: 'the timeline' }] },
    door: 'hook-context',
    origin: { kind: 'hook', event: options.event ?? 'SessionStart' },
    uuid: `hook-row-${keptRowCount}`,
  })
}

test('a terminal session start names a file for the banner, and the card draws what the hook wrote there', async ($, on) => {
  const { record } = stubs(on)
  await $.session.start(terminalSession)
  await $.classic.SessionStart(startup)

  expect(record.sentOn.length).toBe(1)
  expect(record.sentOn[0][SLOT_FILE_KEY]).toBe('/data/claude-mem/session-start-card/session-1.1000.json')
  expect(record.sentOn[0].source).toBe('startup')
  await hookRowKept($)
  expect(record.placedRowIds).toEqual(['session-start-1000'])
  expect(record.notes).toEqual([])

  const ui = await $.ui.mount(cardRow('session-start-1000'))
  expect((await ui.find({ type: 'Text', text: /^claude-mem$/ }))?.text).toBe('claude-mem')
  expect((await ui.find({ type: 'Text', text: /Rules \+ Tools/ }))?.text).toBe('Access Claude-Mem Rules + Tools')
  expect((await ui.find({ type: 'Text', text: /^newest row$/ }))?.text).toBe('newest row')
  expect(await ui.find({ type: 'Box' })).toBeDefined()
  await ui.unmount()
})

test('the terminal fits the brand mark to the viewport and returns long history to full width', async ($, on) => {
  const history = Array.from({ length: 20 }, (_, i) => `observation ${i + 1}`)
  stubs(on, { banner: history.join('\n') })
  await $.session.start(terminalSession)
  await $.classic.SessionStart(startup)
  await hookRowKept($)

  for (const [columns, rows, markWidth, markRows] of [[63, 40, 0, 0], [100, 10, 0, 0], [64, 11, 14, 7], [100, 15, 14, 7], [100, 16, 24, 12]]) {
    const ui = await $.ui.mount({ ...cardRow('session-start-1000'), viewport: { columns, rows, isFullscreen: true } })
    const raster = await ui.findAll({ type: 'Raster' })
    expect(raster.length).toBe(markRows ? 1 : 0)
    expect((await ui.findAll({ type: 'Text', text: /[\u2801-\u28ff]/ })).length).toBe(0)
    expect((await ui.find({ type: 'Text', text: /^claude-mem$/ }))?.text).toBe('claude-mem')
    expect((await ui.find({ type: 'Text', text: /^observation 20$/ }))?.text).toBe(history[19])
    if (markRows) {
      expect(raster[0]?.props.columns).toBe(markWidth)
      expect(raster[0]?.props.rows).toBe(markRows)
      const [frame, band, copy, mark] = await ui.findAll({ type: 'Box' })
      expect(band?.props.flexDirection).toBe('row')
      expect(mark?.props.width).toBe(markWidth)
      expect(mark?.props.flexShrink).toBe(0)
      expect(copy?.text).toContain('observation 15')
      expect(band?.text.includes('observation 16')).toBe(false)
      expect(frame?.text).toContain('observation 16')
      expect(frame?.text).toContain('observation 20')
    }
    await ui.unmount()
  }
})

test('the card waits for the last row of the SessionStart hooks, and no other row places it', async ($, on) => {
  const { record } = stubs(on)
  const session = mock.session(on)
  await $.classic.SessionStart(startup)
  expect(record.placedRowIds).toEqual([])

  // A hook's own message, and another event's combined context, are not the row the card waits for.
  await hookRowKept($, { name: 'hook_system_message' })
  await hookRowKept($, { event: 'UserPromptSubmit' })
  expect(record.placedRowIds).toEqual([])

  await hookRowKept($)
  expect(record.placedRowIds).toEqual(['session-start-1000'])
  // A later row of the same kind places nothing more.
  await hookRowKept($)
  expect(record.placedRowIds).toEqual(['session-start-1000'])
  expect(record.notes).toEqual([])
  // Every row is kept as it came, once: the card relays what it waits on.
  expect(session.appended().map(row => [row.door, row.message.name])).toEqual([
    ['hook-context', 'hook_system_message'],
    ['hook-context', 'hook_additional_context'],
    ['hook-context', 'hook_additional_context'],
    ['hook-context', 'hook_additional_context'],
  ])
})

test('after /clear the new start gets its own file and its own card', async ($, on) => {
  const { clock, record } = stubs(on)
  await $.session.start(terminalSession)
  await $.classic.SessionStart(startup)
  await hookRowKept($)
  await clock.advance(5_000)
  await $.classic.SessionStart({ ...startup, session_id: 'session-2', source: 'clear' })
  await hookRowKept($)

  expect(record.sentOn[1][SLOT_FILE_KEY]).toBe('/data/claude-mem/session-start-card/session-2.6000.json')
  expect(record.placedRowIds).toEqual(['session-start-1000', 'session-start-6000'])
  const ui = await $.ui.mount(cardRow('session-start-6000'))
  expect((await ui.find({ type: 'Text', text: /^newest row$/ }))?.text).toBe('newest row')
  await ui.unmount()
})

test('a compaction passes through untouched until a drawing says the terminal is fullscreen, and then gets its card at once', async ($, on) => {
  const { clock, record } = stubs(on)
  await $.classic.SessionStart(startup)
  await hookRowKept($)

  const mainScreen = await $.ui.mount({ ...cardRow('session-start-1000'), ...onLayout(false) })
  await mainScreen.unmount()
  await clock.advance(5_000)
  await $.classic.SessionStart({ ...startup, source: 'compact' })
  expect(Object.keys(record.sentOn[1]).includes(SLOT_FILE_KEY)).toBe(false)

  const fullscreen = await $.ui.mount({ ...cardRow('session-start-1000'), ...onLayout(true) })
  await fullscreen.unmount()
  await clock.advance(5_000)
  await $.classic.SessionStart({ ...startup, source: 'compact' })
  expect(record.sentOn[2][SLOT_FILE_KEY]).toBe('/data/claude-mem/session-start-card/session-1.11000.json')
  // No row comes after a compaction's hook rows, so its card does not wait for one.
  expect(record.placedRowIds).toEqual(['session-start-1000', 'session-start-11000'])
  const ui = await $.ui.mount({ ...cardRow('session-start-11000'), ...onLayout(true) })
  expect((await ui.find({ type: 'Text', text: /^newest row$/ }))?.text).toBe('newest row')
  await ui.unmount()
  expect(record.notes).toEqual([])
})

test('a -p run gets the event untouched and no card', async ($, on) => {
  const { record } = stubs(on, { entrypoint: 'sdk-cli' })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.classic.SessionStart(startup)
  await hookRowKept($)
  expect(Object.keys(record.sentOn[0]).includes(SLOT_FILE_KEY)).toBe(false)
  expect(record.placedRowIds).toEqual([])
  expect(record.notes).toEqual([])
})

test('a resumed terminal session gets the event untouched and no card', async ($, on) => {
  const { record } = stubs(on)
  await $.session.start(terminalSession)
  await $.classic.SessionStart({ ...startup, source: 'resume' })
  await hookRowKept($)
  expect(Object.keys(record.sentOn[0]).includes(SLOT_FILE_KEY)).toBe(false)
  expect(record.placedRowIds).toEqual([])
})

test('a Claude Code older than the card needs gets the event untouched and no card', async ($, on) => {
  const { record } = stubs(on, { version: '2.1.325' })
  await $.session.start(terminalSession)
  await $.classic.SessionStart(startup)
  await hookRowKept($)
  expect(Object.keys(record.sentOn[0]).includes(SLOT_FILE_KEY)).toBe(false)
  expect(record.placedRowIds).toEqual([])
})

test('a data folder Claude Code cannot make is reported in one line, after the hook rows, and the event goes on untouched', async ($, on) => {
  const { record } = stubs(on, { hookEnv: () => ({ deny: 'cannot make the data folder' }) })
  await $.session.start(terminalSession)
  await $.classic.SessionStart(startup)
  expect(record.sentOn.length).toBe(1)
  expect(Object.keys(record.sentOn[0]).includes(SLOT_FILE_KEY)).toBe(false)
  expect(record.notes).toEqual([])
  await hookRowKept($)
  expect(record.placedRowIds).toEqual([])
  expect(record.notes.length).toBe(1)
  expect(record.notes[0].startsWith(NOT_SHOWN)).toBe(true)
  expect(record.notes[0].includes('cannot make the data folder')).toBe(true)
})

test('no file from the context hook (it sent its own message): nothing is placed and nothing is said', async ($, on) => {
  const { record } = stubs(on, { banner: null })
  await $.session.start(terminalSession)
  await $.classic.SessionStart(startup)
  await hookRowKept($)
  expect(typeof record.sentOn[0][SLOT_FILE_KEY]).toBe('string')
  expect(record.placedRowIds).toEqual([])
  expect(record.notes).toEqual([])
})

test('a card that cannot be placed is reported to the person in one line', async ($, on) => {
  const { record } = stubs(on, { placed: () => ({ isPlaced: false, reason: 'no conversation to place a row in' }) })
  await $.session.start(terminalSession)
  await $.classic.SessionStart(startup)
  await hookRowKept($)
  expect(record.notes).toEqual([`${NOT_SHOWN}no conversation to place a row in`])
})

// From here: a Team or Enterprise account, where the organization's plugin runs first and sends
// classic.SessionStart and session.append past this module (#6314). Only session.start arrives.

test('a start whose SessionStart event never arrives: the card asks with a request file and draws the slot the context hook names', async ($, on) => {
  const { clock, record, files } = stubs(on)
  await $.session.start(terminalSession)
  expect([...files]).toEqual([[`${SLOT_FOLDER}/session-1.1000.request`, '']])
  expect(record.placedRowIds).toEqual([])

  // The context hook finds the request and names a slot by its own clock, 0.3 s on.
  await clock.advance(300)
  files.set(`${SLOT_FOLDER}/session-1.1300.json`, JSON.stringify({ text: BANNER }))
  await clock.advance(100)
  expect(record.placedRowIds).toEqual(['session-start-1300'])

  const ui = await $.ui.mount(cardRow('session-start-1300'))
  expect((await ui.find({ type: 'Text', text: /^claude-mem$/ }))?.text).toBe('claude-mem')
  expect((await ui.find({ type: 'Text', text: /^newest row$/ }))?.text).toBe('newest row')
  await ui.unmount()

  // It has stopped looking.
  await clock.advance(8_000)
  expect([record.listings, record.placedRowIds]).toEqual([2, ['session-start-1300']])
  expect([record.notes, record.debugNotes]).toEqual([[], []])
})

test('a session where both events arrive gets one card, from the SessionStart hook', async ($, on) => {
  const { clock, record, files } = stubs(on)
  await $.session.start(terminalSession)
  await $.classic.SessionStart(startup)
  // The slot the SessionStart hook named is one the request would take for its answer.
  expect([...files.keys()]).toEqual([`${SLOT_FOLDER}/session-1.1000.request`, `${SLOT_FOLDER}/session-1.1000.json`])
  await hookRowKept($)
  await clock.advance(8_000)
  expect(record.placedRowIds).toEqual(['session-start-1000'])
  expect(record.listings).toBe(0)
  expect([record.notes, record.debugNotes]).toEqual([[], []])
})

test('a slot named before the card asked is an earlier start\'s, and is never drawn', async ($, on) => {
  const { clock, record, files } = stubs(on)
  files.set(`${SLOT_FOLDER}/session-1.999.json`, JSON.stringify({ text: 'the banner of an earlier start' }))
  await $.session.start(terminalSession)
  await clock.advance(400)
  expect([record.listings, record.placedRowIds]).toEqual([2, []])

  // This start's slot, beside the earlier one, is the one drawn.
  files.set(`${SLOT_FOLDER}/session-1.1400.json`, JSON.stringify({ text: BANNER }))
  await clock.advance(200)
  expect(record.placedRowIds).toEqual(['session-start-1400'])
  const ui = await $.ui.mount(cardRow('session-start-1400'))
  expect((await ui.find({ type: 'Text', text: /^newest row$/ }))?.text).toBe('newest row')
  await ui.unmount()
  expect(record.notes).toEqual([])
})

test('after 8 seconds without a slot the card stops looking and says so once, in the debug log', async ($, on) => {
  const { clock, record } = stubs(on)
  await $.session.start(terminalSession)
  await clock.advance(7_800)
  expect([record.listings, record.debugNotes]).toEqual([39, []])
  await clock.advance(200)
  expect(record.listings).toBe(40)
  expect(record.debugNotes).toEqual(['claude-mem: the session-start card found no banner in the 8 s after the session started, and stopped looking'])
  await clock.advance(60_000)
  expect([record.listings, record.debugNotes.length, record.notes, record.placedRowIds]).toEqual([40, 1, [], []])
})

test('a session with nobody at the prompt is asked for nothing: the hook is under a matcher', async ($, on) => {
  const { clock, record, files } = stubs(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await clock.advance(8_000)
  expect([[...files], record.listings, record.notes, record.debugNotes]).toEqual([[], 0, [], []])

  // The same session with a person at the prompt asks.
  await $.session.start(terminalSession)
  expect([...files.keys()]).toEqual([`${SLOT_FOLDER}/session-1.9000.request`])
})
