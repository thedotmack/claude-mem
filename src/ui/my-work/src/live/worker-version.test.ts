// Machine and sync shows only a version it read, and says plainly when the read was refused or failed.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readWorkerVersion, WORKER_VERSION_URL, workerVersionReadHere } from './worker-version.ts'

const answer = (status: number, body: string) => async (input: string) => {
  assert.equal(input, WORKER_VERSION_URL)
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
}

describe('the worker version read', () => {
  it('reads the version the worker names', async () => {
    assert.deepEqual(await readWorkerVersion(answer(200, '{"version":"17.0.2"}')), { state: 'read', version: '17.0.2' })
  })
  it('a refusal keeps its status and the reason the server gave (the cloud viewer gate answers 403)', async () => {
    assert.deepEqual(await readWorkerVersion(answer(403, '{"error":"This works only on your own computer."}')),
      { state: 'refused', status: 403, reason: 'This works only on your own computer.' })
    assert.deepEqual(await readWorkerVersion(answer(502, '<html>Bad gateway</html>')), { state: 'refused', status: 502, reason: null })
  })
  it('no answer, or an answer without a version, fails with its cause instead of an empty row', async () => {
    assert.deepEqual(await readWorkerVersion(async () => { throw new TypeError('Failed to fetch') }), { state: 'failed', cause: 'Failed to fetch' })
    const empty = await readWorkerVersion(answer(200, '{}'))
    assert.equal(empty.state, 'failed')
    assert.match(empty.state === 'failed' ? empty.cause : '', /without a version: \{\}/)
    // The whole answer is kept for Details, however long: nothing is cut from it.
    const page = `<html>${'x'.repeat(5_000)}</html>`
    const long = await readWorkerVersion(answer(200, page))
    assert.equal(long.state === 'failed' ? long.cause : '', `The worker answered 200 without a version: ${page}`)
  })
  it('is read where the page reads a worker, and not on cmem.ai, whose page carries its owner meta and runs no worker', () => {
    assert.equal(workerVersionReadHere(null), true)
    assert.equal(workerVersionReadHere('owner-id'), false)
  })
})
