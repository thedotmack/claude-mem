// A chat link is handed to the operating system and its command to a shell, so both are built only from a known tool
// and a session id that is a UUID.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chatIsImplied, chatLinks, requestChat } from './chat-links.ts'

const SESSION = '11111111-2222-4333-8444-555555555555'

test('Claude Code and Codex each get their app link and their resume command', () => {
  assert.deepEqual(chatLinks({ platform: 'claude', sessionId: SESSION }), { tool: 'Claude Code', openHref: `claude://resume?session=${SESSION}`, resumeCommand: `claude --resume ${SESSION}` })
  assert.deepEqual(chatLinks({ platform: 'codex', sessionId: SESSION.toUpperCase() }), { tool: 'Codex', openHref: `codex://threads/${SESSION.toUpperCase()}`, resumeCommand: `codex resume ${SESSION.toUpperCase()}` })
})

test('anything but a UUID builds no link and no command', () => {
  for (const sessionId of ['', 'native-seven', 'abc; rm -rf ~', `${SESSION}; open /`, `${SESSION}&x=1`, ` ${SESSION}`, `${SESSION}\n`, '../../outside', SESSION.replace(/-/g, ''), SESSION.replace('1', 'g')]) {
    assert.equal(chatLinks({ platform: 'claude', sessionId }), undefined, JSON.stringify(sessionId))
    assert.equal(chatLinks({ platform: 'codex', sessionId }), undefined, JSON.stringify(sessionId))
  }
})

test('a tool with no link of its own gets none, and neither does no chat', () => {
  for (const platform of ['gemini', 'cursor', '', 'constructor', '__proto__']) assert.equal(chatLinks({ platform, sessionId: SESSION }), undefined, platform)
  assert.equal(chatLinks(undefined), undefined)
})

test('a request\'s chat is the one recorded on it, else the conversation its own id names', () => {
  const key = JSON.stringify(['conversation', 'claude', SESSION])
  assert.deepEqual(requestChat({ id: key }), { platform: 'claude', sessionId: SESSION })
  assert.deepEqual(requestChat({ id: key, chat: { platform: 'codex', sessionId: SESSION } }), { platform: 'codex', sessionId: SESSION })
  for (const id of ['r1', '["overall-request","g_000000000001"]', '["explicit-request","launch"]', '["conversation","claude"]', '["conversation","claude",7]', `["conversation","claude","${SESSION}","extra"]`, 'null']) {
    assert.equal(requestChat({ id }), undefined, id)
  }
  assert.equal(chatIsImplied(key, { platform: 'claude', sessionId: SESSION }), true)
  assert.equal(chatIsImplied(key, { platform: 'codex', sessionId: SESSION }), false)
  assert.equal(chatIsImplied('["overall-request","g_000000000001"]', { platform: 'claude', sessionId: SESSION }), false)
})
