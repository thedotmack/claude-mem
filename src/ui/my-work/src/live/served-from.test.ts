import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isServedFromCloud } from './served-from.ts'

describe('where the page is served', () => {
  it('treats loopback as this computer and any other host as the cloud viewer', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', '::1']) assert.equal(isServedFromCloud(host), false, host)
    assert.equal(isServedFromCloud('cmem-viewer.fly.dev'), true)
    assert.equal(isServedFromCloud('viewer.cmem.ai'), true)
    assert.equal(isServedFromCloud(''), false)
    assert.equal(isServedFromCloud(undefined), false)
  })
})
