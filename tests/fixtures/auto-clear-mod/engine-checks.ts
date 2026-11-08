// Claude Code test-kit checks for the auto-clear mod (run by `claude plugin test`,
// not bun). tests/integration/auto-clear-mod-engine.test.ts copies this file into
// a scratch plugin as tests/engine.test.ts next to the bundled hooks module.
// Each stub answers in Claude Code's place: the context reading, /clear, prompts.
import { expect, mock, test } from 'claude-code/testing'

const WRITE = 'mcp__plugin_claude-mem_mcp-search__work_state_write'

function stubs(on: any, options: { percent: number; settings?: string | null; surfaces?: string[]; enabled?: boolean }) {
  const clock = mock.clock(on)
  // Auto-clear ships off; these checks turn it on the way a tester does, with the environment variable.
  mock.env(on, options.enabled === false ? { HOME: '/home/ada' } : { HOME: '/home/ada', CLAUDE_MEM_AUTO_CLEAR_ENABLED: 'true' })
  const record = { commands: [] as string[], prompts: [] as Array<{ text: string; asUser?: boolean }>, notes: [] as string[], reads: [] as string[] }
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
  on('tool.call', ($: any, e: any) => e.tool === WRITE
    ? { result: { content: [{ type: 'text', text: 'Saved to "work" in demo.' }], isError: false }, text: 'Saved to "work" in demo.' }
    : { result: 'ok', text: 'ok' })
  return { clock, record, state }
}

const turnDone = { turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer', usage: null }

test('at 34% a tool result carries the save request; after a save the turn end clears and sends continue as the user', async ($, on) => {
  const { clock, record } = stubs(on, { percent: 34 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const bash = await $.tool.call({ tool: 'Bash', command: 'ls' }) as any
  expect(bash.result).toBe('ok')
  expect(bash.context?.at(-1) ?? '').toContain('34% of the context window')
  expect(record.notes[0] ?? '').toContain('Context is at 34%')

  const write = await $.tool.call({ tool: WRITE, list: 'work', fields: { next: 'wire the route' } }) as any
  expect(write.context).toBeUndefined()

  await $.turn.complete(turnDone)
  await clock.settle()
  await clock.settle()
  expect(record.commands).toEqual(['clear'])
  expect(record.prompts).toEqual([{ text: 'continue', asUser: true }])
})

test('below the threshold nothing is attached and nothing runs', async ($, on) => {
  const { clock, record } = stubs(on, { percent: 20 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const bash = await $.tool.call({ tool: 'Bash', command: 'ls' }) as any
  expect(bash.context).toBeUndefined()
  await $.turn.complete(turnDone)
  await clock.settle()
  expect(record.commands).toEqual([])
  expect(record.prompts).toEqual([])
})

test('settings.json moves the threshold and can turn it off', async ($, on) => {
  const { clock, record } = stubs(on, { percent: 40, settings: '{"CLAUDE_MEM_AUTO_CLEAR_PERCENT":"50"}' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const bash = await $.tool.call({ tool: 'Bash', command: 'ls' }) as any
  expect(bash.context).toBeUndefined()
  expect(record.reads).toContain('/home/ada/.claude-mem/settings.json')
  await $.turn.complete(turnDone)
  await clock.settle()
  expect(record.prompts).toEqual([])
})

test('no surface (a -p run or an SDK session): nothing happens', async ($, on) => {
  const { clock, record } = stubs(on, { percent: 80, surfaces: [] })
  await $.session.start({ surface: 'terminal', isInteractive: false, cwd: '/work' })
  const bash = await $.tool.call({ tool: 'Bash', command: 'ls' }) as any
  expect(bash.context).toBeUndefined()
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
  const { clock, record } = stubs(on, { percent: 60 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const sub = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'agent-1' }) as any
  expect(sub.context).toBeUndefined()
  await $.turn.complete({ ...turnDone, agentId: 'agent-1' })
  await clock.settle()
  expect(record.commands).toEqual([])
  expect(record.prompts).toEqual([])
})

test('a refused save never clears: claude-mem asks once in its own turn, then gives up', async ($, on) => {
  const { clock, record } = stubs(on, { percent: 40 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts' })
  await $.turn.complete(turnDone)
  await clock.settle()
  expect(record.prompts.length).toBe(1)
  await $.turn.complete({ ...turnDone, turnId: 't2' })
  await clock.settle()
  expect(record.commands).toEqual([])
  expect(record.notes.at(-1) ?? '').toContain('was not cleared')
})

test('a settings.json that is there but cannot be read keeps auto-clear off instead of guessing', async ($, on) => {
  const { clock, record } = stubs(on, { percent: 80, settings: null })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const bash = await $.tool.call({ tool: 'Bash', command: 'ls' }) as any
  expect(bash.context).toBeUndefined()
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
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: WRITE, list: 'work', fields: { next: 'x' } })
  await $.turn.complete(turnDone)
  await $.turn.start({ text: 'one more thing', turnId: 't2' })
  await clock.settle()
  await clock.settle()
  expect(record.commands).toEqual([])
})

test('off by default: with nothing turned on, a session past the threshold is left alone', async ($, on) => {
  const { clock, record } = stubs(on, { percent: 80, enabled: false })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const bash = await $.tool.call({ tool: 'Bash', command: 'ls' }) as any
  expect(bash.context).toBeUndefined()
  await $.turn.complete(turnDone)
  await clock.settle()
  expect(record.commands).toEqual([])
  expect(record.prompts).toEqual([])
})
