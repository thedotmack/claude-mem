import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CMEM_MCP_URL } from '../setup/agent-connections.ts'
import { clientHandoffPrompt, OTHER_TRIAL_CLIENTS, PRIMARY_TRIAL_CLIENTS } from './cloud-trial-clients.ts'
import { TRIAL_CONNECT_TASK, TRIAL_GUIDE_STEPS } from './cloud-trial-guide.ts'

const english = (text: string) => text

test('each card copies a task first and gives a usable, credential-free setup path if tools are missing', () => {
  for (const client of [...PRIMARY_TRIAL_CLIENTS, ...OTHER_TRIAL_CLIENTS]) {
    for (const task of [TRIAL_CONNECT_TASK, ...TRIAL_GUIDE_STEPS.map(step => step.prompt)]) {
      const prompt = clientHandoffPrompt(client, task, english)
      assert.ok(prompt.startsWith(task))
      assert.ok(prompt.includes(CMEM_MCP_URL))
      assert.ok(prompt.includes('Wait for me to authorize'))
      assert.doesNotMatch(prompt, /\{(?:command|login|setup|url|settings)\}|Bearer |cm_pro_/)
      if (client.settings) assert.ok(prompt.includes(client.settings))
      if (client.commands) {
        assert.ok(prompt.includes(client.commands[0]))
        assert.ok(prompt.includes(client.commands[1]))
      }
    }
  }
})

test('one-tap setup includes separate web settings and conversation destinations', () => {
  const chatgpt = PRIMARY_TRIAL_CLIENTS.find(client => client.id === 'chatgpt')!
  const gemini = PRIMARY_TRIAL_CLIENTS.find(client => client.id === 'gemini-web')!
  assert.equal(chatgpt.open, 'https://chatgpt.com/')
  assert.equal(gemini.open, 'https://gemini.google.com/app')
  for (const client of [chatgpt, gemini]) assert.notEqual(client.open, client.settings)
  assert.ok(TRIAL_CONNECT_TASK.includes('no synced notes'))
})
