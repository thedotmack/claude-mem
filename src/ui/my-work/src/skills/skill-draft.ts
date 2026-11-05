// Browsers normalize textarea line endings to LF. Map the changed span back onto the
// original source so editing a paragraph preserves CRLFs and mixed endings around it.
export function editTextareaValue(previous: string, value: string): string {
  if (!previous.includes('\r')) return value
  const normalized = previous.replace(/\r\n?/g, '\n')
  if (normalized === value) return previous
  let prefix = 0
  while (prefix < normalized.length && prefix < value.length && normalized[prefix] === value[prefix]) prefix++
  let suffix = 0
  while (suffix < normalized.length - prefix && suffix < value.length - prefix &&
    normalized[normalized.length - suffix - 1] === value[value.length - suffix - 1]) suffix++
  let offset = 0
  let start = 0
  let end = 0
  for (let i = 0; i <= normalized.length; i++) {
    if (i === prefix) start = offset
    if (i === normalized.length - suffix) { end = offset; break }
    offset += previous.startsWith('\r\n', offset) ? 2 : 1
  }
  const before = previous.slice(0, start)
  const after = previous.slice(end)
  const lineEnding = before.match(/(\r\n|\r|\n)[^\r\n]*$/)?.[1] ?? previous.match(/\r\n|\r|\n/)?.[0] ?? '\n'
  return before + value.slice(prefix, value.length - suffix).replace(/\n/g, lineEnding) + after
}

export type SkillMode = 'edit' | 'paint'
export type EditKind = 'typing' | 'stroke'
export interface SkillDraft {
  text: string
  baseText: string
  revision: string
  version: number
  history: string[]
  lastTypedAt: number | null
}

export function newDraft(text: string, revision: string): SkillDraft {
  return { text, baseText: text, revision, version: 0, history: [], lastTypedAt: null }
}

export function changeDraft(draft: SkillDraft, text: string, kind: EditKind, now = Date.now()): SkillDraft {
  if (draft.text === text) return draft
  const continuing = kind === 'typing' && draft.lastTypedAt !== null && now - draft.lastTypedAt < 750
  return {
    ...draft, text, version: draft.version + 1,
    history: continuing ? draft.history : [...draft.history.slice(-39), draft.text],
    lastTypedAt: kind === 'typing' ? now : null,
  }
}

// Equal source text can reappear after Undo. A stroke belongs to a particular edit, not just its bytes.
export function applyDraftStroke(draft: SkillDraft, nextText: string, expectedVersion: number): SkillDraft {
  return draft.version === expectedVersion ? changeDraft(draft, nextText, 'stroke') : draft
}

export function undoDraft(draft: SkillDraft): SkillDraft {
  const previous = draft.history.at(-1)
  if (previous === undefined) return draft
  return { ...draft, text: previous, version: draft.version + 1, history: draft.history.slice(0, -1), lastTypedAt: null }
}
