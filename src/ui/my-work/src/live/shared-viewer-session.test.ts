import assert from 'node:assert/strict'
import { it } from 'node:test'
import { sharedViewerFetch } from './shared-viewer-session.ts'

const page = new URL('https://cmem.ai/work')

it('adds the stale-session precondition only on the owner-scoped, same-origin paths', async () => {
  const requests: Request[] = []
  const fetcher = sharedViewerFetch('owner-a', page, async (input, init) => {
    requests.push(input instanceof Request ? input : new Request(new URL(String(input), page), init))
    return Response.json({ ok: true })
  }, () => assert.fail('The authenticated session should be retained'))
  await fetcher('/api/work-view/overview')
  await fetcher('/api/cloud-sync/renewal-status')
  await fetcher('/other')
  await fetcher('https://example.com/api/work-view/overview')
  assert.deepEqual(requests.map(r => r.headers.get('X-Work-Session')), ['owner-a', 'owner-a', null, null])
  assert.deepEqual(requests.map(r => r.redirect), ['error', 'error', 'follow', 'follow'])
})

it('replays a lost write response with the same actor precondition, body, and idempotency key', async () => {
  const sent: Array<{ owner: string | null; key: string | null; body: string }> = []
  const fetcher = sharedViewerFetch('owner-a', page, async input => {
    const req = input as Request
    sent.push({ owner: req.headers.get('X-Work-Session'), key: req.headers.get('Idempotency-Key'), body: await req.text() })
    if (sent.length === 1) throw new TypeError('Connection lost')
    return Response.json({ ok: true })
  }, () => {})
  await fetcher('/api/work-view/review', { method: 'POST', body: '{"checked":true}' })
  assert.equal(sent.length, 2)
  assert.equal(sent[0].owner, 'owner-a')
  assert.ok(sent[0].key)
  assert.deepEqual(sent[0], sent[1])
  await fetcher('/api/work-view/review', { method: 'POST', body: '{"checked":false}' })
  assert.notEqual(sent[2].key, sent[0].key)
})

it('ends a stale page on an account switch without treating a version conflict as logout', async () => {
  let ends = 0
  const bodies = [{ code: 'stale_version' }, { code: 'owner_changed' }]
  const fetcher = sharedViewerFetch('owner-a', page, async () => Response.json(bodies.shift(), { status: 409 }), () => { ends++ })
  await fetcher('/api/work-view/review', { method: 'POST' })
  assert.equal(ends, 0)
  await fetcher('/api/work-view/overview')
  assert.equal(ends, 1)
})

it('discards the displayed account when access expires or the browser signs out', async () => {
  for (const response of [Response.json({ code: 'not_entitled' }, { status: 403 }), new Response(null, { status: 401 })]) {
    let ended = false
    const fetcher = sharedViewerFetch('owner-a', page, async () => response, () => { ended = true })
    await fetcher('/api/work-view/overview')
    assert.equal(ended, true)
  }
})
