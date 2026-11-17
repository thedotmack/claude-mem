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

test('a terminal session start names a file for the banner, and the card draws what the hook wrote there', async ($, on) => {
  const { record } = stubs(on)
  await $.session.start(terminalSession)
  await $.classic.SessionStart(startup)

  expect(record.sentOn.length).toBe(1)
  expect(record.sentOn[0][SLOT_FILE_KEY]).toBe('/data/claude-mem/session-start-card/session-1.1000.json')
  expect(record.sentOn[0].source).toBe('startup')
  expect(record.placedRowIds).toEqual(['session-start-1000'])
  expect(record.notes).toEqual([])

  const ui = await $.ui.mount(cardRow('session-start-1000'))
  expect((await ui.find({ type: 'Text', text: /^claude-mem$/ }))?.text).toBe('claude-mem')
  expect((await ui.find({ type: 'Text', text: /Rules \+ Tools/ }))?.text).toBe('Access Claude-Mem Rules + Tools')
  expect((await ui.find({ type: 'Text', text: /^newest row$/ }))?.text).toBe('newest row')
  expect(await ui.find({ type: 'Box' })).toBeDefined()
  await ui.unmount()
})

test('the SessionStart hooks finishing before the screen is up: the card is placed once it is', async ($, on) => {
  const { record } = stubs(on)
  await $.classic.SessionStart(startup)
  expect(record.sentOn[0][SLOT_FILE_KEY]).toBe('/data/claude-mem/session-start-card/session-1.1000.json')
  expect(record.placedRowIds).toEqual([])

  await $.session.start(terminalSession)
  expect(record.placedRowIds).toEqual(['session-start-1000'])
  const ui = await $.ui.mount(cardRow('session-start-1000'))
  expect((await ui.find({ type: 'Text', text: /^newest row$/ }))?.text).toBe('newest row')
  await ui.unmount()
})

test('after /clear the new start gets its own file and its own card', async ($, on) => {
  const { clock, record } = stubs(on)
  await $.session.start(terminalSession)
  await $.classic.SessionStart(startup)
  await clock.advance(5_000)
  await $.classic.SessionStart({ ...startup, session_id: 'session-2', source: 'clear' })

  expect(record.sentOn[1][SLOT_FILE_KEY]).toBe('/data/claude-mem/session-start-card/session-2.6000.json')
  expect(record.placedRowIds).toEqual(['session-start-1000', 'session-start-6000'])
  const ui = await $.ui.mount(cardRow('session-start-6000'))
  expect((await ui.find({ type: 'Text', text: /^newest row$/ }))?.text).toBe('newest row')
  await ui.unmount()
})

test('a -p run gets the event untouched and no card', async ($, on) => {
  const { record } = stubs(on, { entrypoint: 'sdk-cli' })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.classic.SessionStart(startup)
  expect(Object.keys(record.sentOn[0]).includes(SLOT_FILE_KEY)).toBe(false)
  expect(record.placedRowIds).toEqual([])
  expect(record.notes).toEqual([])
})

test('a resumed terminal session gets the event untouched and no card', async ($, on) => {
  const { record } = stubs(on)
  await $.session.start(terminalSession)
  await $.classic.SessionStart({ ...startup, source: 'resume' })
  expect(Object.keys(record.sentOn[0]).includes(SLOT_FILE_KEY)).toBe(false)
  expect(record.placedRowIds).toEqual([])
})

test('a Claude Code older than the card needs gets the event untouched and no card', async ($, on) => {
  const { record } = stubs(on, { version: '2.1.325' })
  await $.session.start(terminalSession)
  await $.classic.SessionStart(startup)
  expect(Object.keys(record.sentOn[0]).includes(SLOT_FILE_KEY)).toBe(false)
  expect(record.placedRowIds).toEqual([])
})

test('a data folder Claude Code cannot make is reported in one line, and the event goes on untouched', async ($, on) => {
  const { record } = stubs(on, { hookEnv: () => ({ deny: 'cannot make the data folder' }) })
  await $.session.start(terminalSession)
  await $.classic.SessionStart(startup)
  expect(record.sentOn.length).toBe(1)
  expect(Object.keys(record.sentOn[0]).includes(SLOT_FILE_KEY)).toBe(false)
  expect(record.placedRowIds).toEqual([])
  expect(record.notes.length).toBe(1)
  expect(record.notes[0].startsWith('claude-mem: the session-start card is not shown: ')).toBe(true)
  expect(record.notes[0].includes('cannot make the data folder')).toBe(true)
})

test('no file from the context hook (it sent its own message): nothing is placed and nothing is said', async ($, on) => {
  const { record } = stubs(on, { banner: null })
  await $.session.start(terminalSession)
  await $.classic.SessionStart(startup)
  expect(typeof record.sentOn[0][SLOT_FILE_KEY]).toBe('string')
  expect(record.placedRowIds).toEqual([])
  expect(record.notes).toEqual([])
})

test('a card that cannot be placed is reported to the person in one line', async ($, on) => {
  const { record } = stubs(on, { placed: () => ({ isPlaced: false, reason: 'no conversation to place a row in' }) })
  await $.session.start(terminalSession)
  await $.classic.SessionStart(startup)
  expect(record.notes).toEqual(['claude-mem: the session-start card is not shown: no conversation to place a row in'])
})
