// Claude Code test-kit checks for the auto-clear mod (run by `claude plugin test`,
// not bun). tests/integration/auto-clear-mod-engine.test.ts copies this file into
// a scratch plugin as tests/engine.test.ts next to the bundled hooks module.
// Each stub answers in Claude Code's place: the context reading, /clear, prompts.
// A finished tool call is raised the way the engine raises it: as the
// `session.append` row of its result (door `tool-result`), and the reminder the
// mod appends comes back through `mock.session` as a row of the door `note`.
import { expect, mock, test } from 'claude-code/testing'

const WRITE = 'mcp__plugin_claude-mem_mcp-search__work_state_write'

function stubs(on: any, options: { percent: number; settings?: string | null; surfaces?: string[]; enabled?: boolean }) {
  const clock = mock.clock(on)
  // Auto-clear ships off; these checks turn it on the way a tester does, with the environment variable.
  mock.env(on, options.enabled === false ? { HOME: '/home/ada' } : { HOME: '/home/ada', CLAUDE_MEM_AUTO_CLEAR_ENABLED: 'true' })
  const record = { commands: [] as string[], prompts: [] as Array<{ text: string; asUser?: boolean }>, notes: [] as string[], reads: [] as string[] }
  const session = mock.session(on)
  const state = { percent: options.percent }
  const isSettings = (path: string) => options.settings !== undefined && path.endsWith('/.claude-mem/settings.json')
  on('fs.exists', ($: any, e: any) => ({ value: isSettings(e.path) }))
  on('fs.read', ($: any, e: any) => {
    record.reads.push(e.path)
    if (isSettings(e.path)) return options.settings === null ? { deny: 'EACCES' } : { value: options.settings }
    return { deny: 'missing' }
  })
  on('session.usage', () => ({ value: { context: { tokens: state.percent * 2000, window: 200000, percent: state.percent }, rateLimits: [] } }))
  on('session.surfaces', () => ({ value: options.surfaces ?? ['terminal'] }))
  on('ui.log', ($: any, e: any) => { record.notes.push(e.text); return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', ($: any, e: any) => ({ sessionId: 's1' }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.run', ($: any, e: any) => { record.commands.push(e.command); return { text: '' } })
  on('prompt.submit', ($: any, e: any) => { record.prompts.push({ text: e.text, asUser: e.origin?.asUser }); return { text: e.text } })
  // What the mod appended for Claude to read (a plugin's own row has the door `note`), as text.
  const reminders = () => session.appended()
    .filter((row: any) => row.door === 'note' && row.origin.kind === 'plugin')
    .map((row: any) => row.message.content.map((block: any) => block.text).join(''))
  return { clock, record, state, reminders }
}

let rows = 0
/**
 * Raises a stored tool result as the engine does. `content` is what the model
 * reads: a string, a block array, or '' as Code Mode stores a script's calls.
 */
async function toolResult($: any, tool: string, content: unknown = 'ok', options: { isError?: boolean; agentId?: string } = {}) {
  rows += 1
  const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: `toolu_${rows}`, content }
  if (options.isError !== undefined) block.is_error = options.isError
  return await $.session.append({
    message: { type: 'user', role: 'user', content: [block] },
    door: 'tool-result',
    origin: { kind: 'tool', tool },
    uuid: `row-${rows}`,
    ...(options.agentId ? { agentId: options.agentId } : {}),
  })
}
const saved = [{ type: 'text', text: 'Saved to "work" in demo.' }]

const turnDone = { turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer', usage: null }

test('at 34% a tool result gets the save request appended behind it; after a save the turn end clears and sends continue as the user', async ($, on) => {
  const { clock, record, reminders } = stubs(on, { percent: 34 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  // The row is stored as the tool made it; the save request is a row of its own behind it.
  const bash = await toolResult($, 'Bash', 'ok')
  expect(bash.message.content[0].content).toBe('ok')
  expect(reminders()).toHaveLength(1)
  expect(reminders()[0]).toContain('34% of the context window')
  expect(reminders()[0]).toContain('work_state_write')
  expect(record.notes[0] ?? '').toContain('Context is at 34%')

  await toolResult($, WRITE, saved)
  expect(reminders()).toHaveLength(1)

  await $.turn.complete(turnDone)
  await clock.settle()
  await clock.settle()
  expect(record.commands).toEqual(['clear'])
  expect(record.prompts).toEqual([{ text: 'continue', asUser: true }])
})

test('below the threshold nothing is attached and nothing runs', async ($, on) => {
  const { clock, record, reminders } = stubs(on, { percent: 20 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await toolResult($, 'Bash')
  expect(reminders()).toEqual([])
  await $.turn.complete(turnDone)
  await clock.settle()
  expect(record.commands).toEqual([])
  expect(record.prompts).toEqual([])
})

test('settings.json moves the threshold and can turn it off', async ($, on) => {
  const { clock, record, reminders } = stubs(on, { percent: 40, settings: '{"CLAUDE_MEM_AUTO_CLEAR_PERCENT":"50"}' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await toolResult($, 'Bash')
  expect(reminders()).toEqual([])
  expect(record.reads).toContain('/home/ada/.claude-mem/settings.json')
  await $.turn.complete(turnDone)
  await clock.settle()
  expect(record.prompts).toEqual([])
})

test('no surface (a -p run or an SDK session): nothing happens', async ($, on) => {
  const { clock, record, reminders } = stubs(on, { percent: 80, surfaces: [] })
  await $.session.start({ surface: 'terminal', isInteractive: false, cwd: '/work' })
  await toolResult($, 'Bash')
  expect(reminders()).toEqual([])
  await $.turn.complete(turnDone)
  await clock.settle()
  expect(record.commands).toEqual([])
  expect(record.prompts).toEqual([])
})

test('a turn that crossed with no tool call gets a save prompt from claude-mem, not as the user', async ($, on) => {
  const { clock, record } = stubs(on, { percent: 45 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.complete(turnDone)
  await clock.settle()
  expect(record.prompts.length).toBe(1)
  expect(record.prompts[0].text).toContain('45% of the context window')
  expect(record.prompts[0].asUser).toBeUndefined()
  expect(record.commands).toEqual([])
})

test('subagent tool calls and turns are never counted', async ($, on) => {
  const { clock, record, reminders } = stubs(on, { percent: 60 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await toolResult($, 'Bash', 'ok', { agentId: 'agent-1' })
  expect(reminders()).toEqual([])
  await $.turn.complete({ ...turnDone, agentId: 'agent-1' })
  await clock.settle()
  expect(record.commands).toEqual([])
  expect(record.prompts).toEqual([])
})

test('a refused save never clears: claude-mem asks once in its own turn, then gives up', async ($, on) => {
  const { clock, record } = stubs(on, { percent: 40 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await toolResult($, 'Bash')
  await toolResult($, 'Edit')
  await $.turn.complete(turnDone)
  await clock.settle()
  expect(record.prompts.length).toBe(1)
  await $.turn.complete({ ...turnDone, turnId: 't2' })
  await clock.settle()
  expect(record.commands).toEqual([])
  expect(record.notes.at(-1) ?? '').toContain('was not cleared')
})

test('a settings.json that is there but cannot be read keeps auto-clear off instead of guessing', async ($, on) => {
  const { clock, record, reminders } = stubs(on, { percent: 80, settings: null })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await toolResult($, 'Bash')
  expect(reminders()).toEqual([])
  await $.turn.complete(turnDone)
  await clock.settle()
  expect(record.prompts).toEqual([])
})

test('a stopped turn past the threshold sends nothing', async ($, on) => {
  const { clock, record } = stubs(on, { percent: 50 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.complete({ ...turnDone, isAborted: true, reason: 'aborted' })
  await clock.settle()
  expect(record.prompts).toEqual([])
})

test('a prompt the person typed that starts before the clear holds the clear back', async ($, on) => {
  const { clock, record } = stubs(on, { percent: 40 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await toolResult($, 'Bash')
  await toolResult($, WRITE, saved)
  await $.turn.complete(turnDone)
  await $.turn.start({ text: 'one more thing', turnId: 't2' })
  await clock.settle()
  await clock.settle()
  expect(record.commands).toEqual([])
})

test('off by default: with nothing turned on, a session past the threshold is left alone', async ($, on) => {
  const { clock, record, reminders } = stubs(on, { percent: 80, enabled: false })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await toolResult($, 'Bash')
  expect(reminders()).toEqual([])
  await $.turn.complete(turnDone)
  await clock.settle()
  expect(record.commands).toEqual([])
  expect(record.prompts).toEqual([])
})

test('an error result for the save is not a save: no clear after it', async ($, on) => {
  const { clock, record } = stubs(on, { percent: 40 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await toolResult($, 'Bash')
  await toolResult($, WRITE, 'Worker API error (500)', { isError: true })
  await $.turn.complete(turnDone)
  await clock.settle()
  expect(record.commands).toEqual([])
})

test('Code Mode: a script\'s save is stored with no text, so nothing is cleared and the person is told why', async ($, on) => {
  const { clock, record, reminders } = stubs(on, { percent: 40 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  // REPL's own result row comes first, then one row per tool the script called.
  await toolResult($, 'REPL', '(dispatched #2)')
  expect(reminders()).toHaveLength(1)
  await toolResult($, WRITE, '', { isError: false })
  expect(record.notes.at(-1) ?? '').toContain('Code Mode')
  expect(record.notes.at(-1) ?? '').toContain('did not clear the conversation')

  await $.turn.complete(turnDone)
  await clock.settle()
  await clock.settle()
  expect(record.commands).toEqual([])
  expect(record.prompts).toEqual([])

  // Off for the rest of the session: no further request, even past the threshold.
  const notesBefore = record.notes.length
  await toolResult($, 'Bash')
  await $.turn.complete({ ...turnDone, turnId: 't2' })
  await clock.settle()
  expect(reminders()).toHaveLength(1)
  expect(record.prompts).toEqual([])
  expect(record.notes).toHaveLength(notesBefore)
})
