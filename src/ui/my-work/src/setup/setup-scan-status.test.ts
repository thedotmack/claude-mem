// Run with `npm test`. The Scan screen says when a found agent cannot run setup, with the detection's reason.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { scanAgentStatus } from './setup-scan-status.ts'

const agent = { id: 'gemini-cli', label: 'Gemini CLI', detected: true, prompts: 12 }

describe('scan agent status', () => {
  it('an agent that can run setup, or is not checked, reads as detected', () => {
    assert.deepEqual(scanAgentStatus({ ...agent, canRunSetup: true, cannotRunReason: null }), { label: 'detected', note: null })
    assert.deepEqual(scanAgentStatus({ ...agent, canRunSetup: null, cannotRunReason: null }), { label: 'detected', note: null })
  })

  it('an account Google refuses says it cannot run setup, and why', () => {
    const reason = "Gemini is installed, but this Google account can't use it: This client is no longer supported for Gemini Code Assist for individuals."
    assert.deepEqual(scanAgentStatus({ ...agent, canRunSetup: false, cannotRunReason: reason }), { label: "detected, can't run setup", note: reason })
  })
})
