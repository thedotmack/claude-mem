import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDraftStroke, changeDraft, editTextareaValue, newDraft, undoDraft } from './skill-draft.ts'
import { getSkillSource } from './skill-source.ts'

test('editing one textarea paragraph preserves BOM, comments, future fields, mixed line endings and the final newline', () => {
  const original = '\uFEFF---\r\n# explain\r\nfuture: keep\n---\r\n\r\nOld paragraph.\r\n\nLast line.\r\n'
  const normalized = original.replace(/\r\n?/g, '\n')
  assert.equal(editTextareaValue(original, normalized), original)
  assert.equal(editTextareaValue(original, normalized.replace('Old paragraph.', 'One.\nTwo.')), original.replace('Old paragraph.', 'One.\r\nTwo.'))
  assert.equal(editTextareaValue(original, normalized.slice(0, -1)), original.slice(0, -2))
  assert.equal(editTextareaValue('a\rb\rc', 'a\nb\nB\nc'), 'a\rb\rB\rc')
})

test('idle typing starts a fresh Undo and a paint stroke always has its own Undo', () => {
  const original = 'first\r\n'
  let draft = newDraft(original, 'hash')
  draft = changeDraft(draft, original+'a', 'typing', 100)
  draft = changeDraft(draft, original+'ab', 'typing', 150)
  draft = changeDraft(draft, original+'abc', 'typing', 3000)
  draft = changeDraft(draft, 'painted', 'stroke', 3030)
  assert.equal(draft.history.length, 3)
  draft = undoDraft(draft); assert.equal(draft.text, original+'abc')
  draft = undoDraft(draft); assert.equal(draft.text, original+'ab')
  draft = undoDraft(draft); assert.equal(draft.text, original)
  assert.equal(draft.revision, 'hash')
})

test('sample saves are isolated from fetch and keep a usable newer document after conflicts', async () => {
  const source = getSkillSource('sample')
  const { skills } = await source.list()
  const opened = await source.open(skills[0].id)
  const next = opened.text+'\nOwner edit.'
  const receipt = await source.save(opened.entry.id, opened.revision, next)
  assert.equal((await source.open(opened.entry.id)).text, next)
  await assert.rejects(source.save(opened.entry.id, opened.revision, 'Other change'), {status:409})
  await source.save(opened.entry.id, receipt.revision, opened.text)
})

test('a delayed rewrite cannot apply after Edit and Undo return to the exact starting text', () => {
  const original = newDraft('# Original', 'hash')
  const different = changeDraft(original, '# Edited', 'typing', 10)
  const back = undoDraft(different)
  assert.equal(back.text, original.text)
  assert.strictEqual(applyDraftStroke(back, '# Stale rewrite', original.version), back)
  const applied = applyDraftStroke(back, '# New rewrite', back.version)
  assert.equal(undoDraft(applied).text, original.text)
})
