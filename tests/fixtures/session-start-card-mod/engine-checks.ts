// Claude Code test-kit checks for the session-start card (run by `claude plugin test`,
// not bun). tests/integration/hooks-module-engine.test.ts copies this file into a
// scratch plugin's tests/ folder, next to the bundled hooks module. They need the
// first Claude Code with every call the card makes (2.1.326 or later). Each stub
// answers in Claude Code's place: its version, the hook environment, files, and
// the placing of a row.
import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'hooks-module-engine-test'
const SLOT_FILE_KEY = 'claude_mem_session_start_card_file'
const BANNER = '\x1b[2mAccess Claude-Mem Rules + Tools\x1b[0m\n\n  \x1b[36m#12\x1b[0m  \x1b[1mnewest row\x1b[0m'
const NOT_SHOWN = 'claude-mem: the session-start card is not shown: '

function stubs(on: any, options: { entrypoint?: string; version?: string; hookEnv?: () => unknown; banner?: string | null; placed?: () => unknown } = {}) {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { HOME: '/home/ada', CLAUDE_CODE_ENTRYPOINT: options.entrypoint ?? 'cli' })
  const record = { sentOn: [] as any[], placedRowIds: [] as string[], notes: [] as string[] }
  const files = new Map<string, string>()
  on('session.version', () => ({ value: { version: options.version ?? '2.1.326', base: options.version ?? '2.1.326' } }))
  on('process.hookEnv', () => (options.hookEnv ? options.hookEnv() : { value: { CLAUDE_PLUGIN_DATA: '/data/claude-mem' } }))
  on('fs.exists', ($: any, e: any) => ({ value: files.has(e.path) }))
  on('fs.read', ($: any, e: any) => (files.has(e.path) ? { value: files.get(e.path) } : { deny: 'missing' }))
  on('ui.place', ($: any, e: any) => {
    record.placedRowIds.push(e.id)
    return { value: options.placed ? options.placed() : { isPlaced: true, requestId: `request-${e.id}` } }
  })
  on('ui.log', ($: any, e: any) => { record.notes.push(e.text); return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }))
  // The SessionStart command hooks: the context hook writes the banner to the file the card named.
  on('classic.SessionStart', ($: any, e: any) => {
    record.sentOn.push(e)
    if (e[SLOT_FILE_KEY] && options.banner !== null) files.set(e[SLOT_FILE_KEY], JSON.stringify({ text: options.banner ?? BANNER }))
    return { additionalContext: ['the timeline'] }
  })
  return { clock, record }
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
    const dots = await ui.findAll({ type: 'Text', text: /[\u2801-\u28ff]/ })
    expect(dots.length).toBe(markRows)
    expect(dots.every(row => row.text.length === markWidth)).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^claude-mem$/ }))?.text).toBe('claude-mem')
    expect((await ui.find({ type: 'Text', text: /^observation 20$/ }))?.text).toBe(history[19])
    if (markRows) {
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
