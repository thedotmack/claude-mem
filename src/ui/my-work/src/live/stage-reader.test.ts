// Run with `npm test`. What a row's Stage cell offers and what a ready stage opens (components/thread-list.tsx, stage-reader.tsx).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Request, RequestStage, StageFormatInfo } from '../data.ts'
import { readerCheck, stageCell, stageReading } from './stage-reader.ts'

const FORMATS: StageFormatInfo[] = [{ id: 'brief', label: 'Brief', output: 'markdown', builtIn: true }, { id: 'deck', label: 'Deck', output: 'html', builtIn: true }]
const stage = (formatId: string, state: RequestStage['state'], change: Partial<RequestStage> = {}): RequestStage => ({ formatId, state, startedAt: '2026-11-12T10:00:00Z', generatedAt: null, reviewedThrough: null, error: null, trigger: 'owner', outdated: false, ...change })
const product = { kind: 'PR', label: '#12 the change', href: 'https://example.com/pull/12' } as Request['workProduct'][number]
const row = (change: Partial<Pick<Request, 'readyStages' | 'stages' | 'workProduct'>> = {}) => ({ workProduct: [], ...change })

describe('the Stage cell on a row that waits for a review', () => {
  it('with nothing made, offers to generate the default format and names no stage', () => {
    assert.deepEqual(stageCell(row(), FORMATS), { stage: { kind: 'none', formatId: 'brief', label: 'Brief' }, product: null })
    // The format automatic stages use is the default once the owner chose one.
    assert.deepEqual(stageCell(row(), FORMATS, 'deck').stage, { kind: 'none', formatId: 'deck', label: 'Deck' })
    assert.deepEqual(stageCell(row(), FORMATS, 'gone').stage, { kind: 'none', formatId: 'brief', label: 'Brief' })
  })
  it('says a stage is being made', () => {
    assert.deepEqual(stageCell(row({ stages: [stage('brief', 'generating')] }), FORMATS).stage, { kind: 'making', formatId: 'brief', label: 'Brief' })
  })
  it('names a ready stage by its format, from the row\'s own record or the detail, and it stands in for the deliverable', () => {
    assert.deepEqual(stageCell(row({ readyStages: ['deck'], workProduct: [product] }), FORMATS), { stage: { kind: 'ready', formatId: 'deck', label: 'Deck' }, product: null })
    assert.deepEqual(stageCell(row({ stages: [stage('deck', 'failed'), stage('brief', 'ready', { href: '/api/deliverables/3/stage-a-brief.md' })] }), FORMATS).stage, { kind: 'ready', formatId: 'brief', label: 'Brief' })
    // The detail is newer than the row's list: a stage being made again is not ready.
    assert.equal(stageCell(row({ readyStages: ['brief'], stages: [stage('brief', 'generating')] }), FORMATS).stage?.kind, 'making')
  })
  it('says why a stage failed, and it can be made again', () => {
    assert.deepEqual(stageCell(row({ stages: [stage('brief', 'failed', { error: 'The agent is signed out.' })] }), FORMATS).stage, { kind: 'failed', formatId: 'brief', label: 'Brief', error: 'The agent is signed out.' })
  })
  it('keeps the deliverable beside the offer when there is a product and no stage', () => {
    assert.deepEqual(stageCell(row({ workProduct: [product] }), FORMATS), { stage: { kind: 'none', formatId: 'brief', label: 'Brief' }, product })
  })
  it('offers nothing to make on a worker that lists no formats, and names a ready stage of a format it no longer lists by its id', () => {
    assert.deepEqual(stageCell(row({ workProduct: [product] }), []), { stage: null, product })
    assert.deepEqual(stageCell(row({ readyStages: ['mine'] }), FORMATS).stage, { kind: 'ready', formatId: 'mine', label: 'mine' })
  })
})

describe('what a ready stage opens', () => {
  it('opens the reader with the format and the file\'s address: Markdown as a document, HTML for the sandboxed frame', () => {
    assert.deepEqual(stageReading(stage('brief', 'ready', { href: '/api/deliverables/3/stage-a-brief.md' }), FORMATS), { formatId: 'brief', label: 'Brief', href: '/api/deliverables/3/stage-a-brief.md', output: 'markdown', newTabHref: '/api/deliverables/3/stage-a-brief.md', outdated: false })
    assert.equal(stageReading(stage('brief', 'ready', { href: '/api/deliverables/3/stage-a-brief.md', outdated: true }), FORMATS)!.outdated, true)
    assert.equal(stageReading(stage('deck', 'ready', { href: '/api/deliverables/4/stage-a-deck.html' }), FORMATS)!.output, 'html')
  })
  it('has no tab to open for a sample stage, whose text rides in its address', () => {
    assert.equal(stageReading(stage('brief', 'ready', { href: 'data:text/markdown;charset=utf-8,%23%20Hi' }), FORMATS)!.newTabHref, null)
  })
  it('opens nothing for a stage that is not ready, has no file, or is in a format the worker does not list', () => {
    assert.equal(stageReading(stage('brief', 'generating'), FORMATS), null)
    assert.equal(stageReading(stage('brief', 'failed', { href: '/x' }), FORMATS), null)
    assert.equal(stageReading(stage('brief', 'ready'), FORMATS), null)
    assert.equal(stageReading(stage('brief', 'ready', { href: '#' }), FORMATS), null)
    assert.equal(stageReading(stage('mine', 'ready', { href: '/x' }), FORMATS), null)
    assert.equal(stageReading(undefined, FORMATS), null)
  })
})

describe('"Mark checked" in the reader', () => {
  const read = { fingerprint: 'v1', outdated: false }
  it('is offered for the version the stage was opened on', () => {
    assert.equal(readerCheck(read, { waitsForCheck: true, fingerprint: 'v1' }), 'offer')
    // The sample's requests carry no version.
    assert.equal(readerCheck({ fingerprint: undefined, outdated: false }, { waitsForCheck: true, fingerprint: undefined }), 'offer')
  })
  it('is withdrawn when new work arrives while the stage is open, though the request still waits for a check', () => {
    assert.equal(readerCheck(read, { waitsForCheck: true, fingerprint: 'v2' }), 'changed')
    assert.equal(readerCheck(read, { waitsForCheck: true, fingerprint: undefined }), 'changed')
  })
  it('is refused from a stage written before the request\'s current work, even with nothing arriving while it is open', () => {
    assert.equal(readerCheck({ fingerprint: 'v2', outdated: true }, { waitsForCheck: true, fingerprint: 'v2' }), 'outdated')
  })
  it('is not there before anything was read, or on a request that does not wait for a check', () => {
    assert.equal(readerCheck(null, { waitsForCheck: true, fingerprint: 'v1' }), 'none')
    assert.equal(readerCheck(read, { waitsForCheck: false, fingerprint: 'v1' }), 'none')
    assert.equal(readerCheck({ fingerprint: 'v1', outdated: true }, { waitsForCheck: false, fingerprint: 'v2' }), 'none')
  })
})
