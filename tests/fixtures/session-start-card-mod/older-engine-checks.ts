// Claude Code test-kit checks for the session-start card on a Claude Code older
// than the card needs (run by `claude plugin test`, not bun; engine-checks.ts
// beside this file has the card's own). The hooks module still loads there, and
// the card must leave SessionStart alone, so the context hook sends its whole
// message as before. Nothing here answers `process.hookEnv` or `ui.place`: an
// older build refuses a stub for a call it lacks, and the card makes neither.
import { expect, mock, test } from 'claude-code/testing'

const SLOT_FILE_KEY = 'claude_mem_session_start_card_file'

// The test kit has no version of its own to answer with, so a stub says which
// Claude Code this is: the first with mods, and the last before the card's.
for (const version of ['2.1.287', '2.1.325']) {
  test(`a terminal session start on Claude Code ${version} passes through untouched, and nothing is said`, async ($, on) => {
    mock.clock(on, { now: 1_000 })
    mock.env(on, { HOME: '/home/ada', CLAUDE_CODE_ENTRYPOINT: 'cli' })
    const sentOn: any[] = []
    const notes: string[] = []
    on('session.version', () => ({ value: { version, base: version } }))
    on('ui.log', ($: any, e: any) => { notes.push(e.text); return { value: undefined } })
    on('session.start', () => ({ cwd: '/work' }))
    on('classic.SessionStart', ($: any, e: any) => { sentOn.push(e); return { additionalContext: ['the timeline'] } })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const result = await $.classic.SessionStart({ session_id: 'session-1', source: 'startup', hook_event_name: 'SessionStart', cwd: '/work', transcript_path: '/work/t.jsonl' })

    expect(sentOn.length).toBe(1)
    expect(Object.keys(sentOn[0]).includes(SLOT_FILE_KEY)).toBe(false)
    expect(JSON.stringify(result)).toContain('the timeline')
    expect(notes).toEqual([])
  })
}
