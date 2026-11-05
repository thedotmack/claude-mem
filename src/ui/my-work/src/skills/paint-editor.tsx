import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { ArrowDownIcon, ArrowUpIcon, BrainIcon, EraserIcon, PencilIcon, UserRoundIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { applyPaintEdit, readPaintDocument } from '../../../../shared/skill-paint'
import { editTextareaValue } from './skill-draft'
import { PaintMarkdown } from './paint-markdown'
import type { AiStamp, RewritePassage } from './skill-source'

const tools = [
  { id: 'pencil', label: 'Pencil', icon: PencilIcon, hint: 'Select a passage to edit its Markdown.' },
  { id: 'human', label: 'Human', icon: UserRoundIcon, hint: 'Paint a passage to rewrite it in plain language.' },
  { id: 'einstein', label: 'Einstein', icon: BrainIcon, hint: 'Paint a passage to explain the principle behind it.' },
  { id: 'eraser', label: 'Eraser', icon: EraserIcon, hint: 'Paint the passages you want to remove.' },
  { id: 'more', label: 'More', icon: ArrowUpIcon, hint: 'Paint a heading to promote it, or move a passage earlier.' },
  { id: 'less', label: 'Less', icon: ArrowDownIcon, hint: 'Paint a heading to demote it, or move a passage later.' },
] as const

type Tool = typeof tools[number]['id']
type Range = { firstIndex: number; lastIndex: number }
type Stroke = { pointerId: number; range: Range }
interface PencilEdit { index: number; markdown: string }
interface Props {
  skillId: string
  text: string
  version: number
  editable: boolean
  rewrite?: RewritePassage
  onChange: (text: string, expectedVersion: number) => void
}
const isAi = (tool: Tool): tool is AiStamp => tool === 'human' || tool === 'einstein'

export function SkillPaintEditor({ skillId, text, version, editable, rewrite, onChange }: Props) {
  const { blocks } = useMemo(() => readPaintDocument(text), [text])
  const choices = useMemo(() => blocks.flatMap((block, index) => block.kind === 'blank' ? [] : [{ index, label: block.markdown.trim().replace(/\s+/g, ' ').slice(0, 56) }]), [blocks])
  const [tool, setTool] = useState<Tool>('pencil')
  const [marked, setMarked] = useState<(Range & { version: number }) | null>(null)
  const [editing, setEditing] = useState<(PencilEdit & { version: number }) | null>(null)
  const range = marked?.version === version ? marked : null
  const pencil = editing?.version === version ? editing : null
  const setRange = (value: Range | null) => setMarked(value && { ...value, version })
  const setPencil = (value: PencilEdit | null) => setEditing(value && { ...value, version })
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [pendingVersion, setPendingVersion] = useState<number | null>(null)
  const busy = pendingVersion === version && editable
  const stroke = useRef<Stroke | null>(null)
  const request = useRef<AbortController | null>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const firstChoice = choices[0]?.index ?? 0
  const selection = range ?? { firstIndex: firstChoice, lastIndex: firstChoice }
  const currentTool = tools.find(item => item.id === tool)!
  const canApply = editable && choices.length > 0 && (!isAi(tool) || !!rewrite)

  const cancelRequest = () => {
    request.current?.abort()
    request.current = null
    setPendingVersion(null)
  }
  const reset = () => {
    cancelRequest()
    stroke.current = null
    setPencil(null)
    setRange(null)
    setMessage('')
    setError('')
  }
  // A late reply can arrive after Undo, selecting another skill, or leaving Paint.
  // The parent also compares the monotonic draft version just before applying a stroke.
  useLayoutEffect(() => () => { request.current?.abort(); request.current = null; stroke.current = null }, [skillId, version, editable])

  function changeTool(next: Tool) {
    reset()
    setTool(next)
  }
  function editPencil() {
    if (!pencil || !editable) return
    const next = applyPaintEdit(text, pencil.index, pencil.index, { tool: 'pencil', markdown: pencil.markdown })
    setPencil(null)
    if (next !== text) { onChange(next, version); setMessage('Passage edited.') }
  }
  async function apply(bounds: Range) {
    if (!canApply) return
    cancelRequest()
    setMessage('')
    setError('')
    setRange(bounds)
    if (tool === 'pencil') {
      const index = bounds.firstIndex
      setRange({ firstIndex: index, lastIndex: index })
      setPencil({ index, markdown: blocks[index].markdown.replace(/(?:\r\n|\n|\r)+$/, '') })
      return
    }
    const controller = isAi(tool) ? new AbortController() : null
    try {
      let next: string
      if (isAi(tool)) {
        if (!rewrite || !controller) return
        request.current = controller
        setPendingVersion(version)
        const markdown = await rewrite(skillId, tool, text, bounds.firstIndex, bounds.lastIndex, controller.signal)
        if (controller.signal.aborted || request.current !== controller) return
        next = applyPaintEdit(text, bounds.firstIndex, bounds.lastIndex, { tool, markdown })
      } else {
        next = applyPaintEdit(text, bounds.firstIndex, bounds.lastIndex, { tool })
      }
      if (next === text) {
        setMessage('This passage is already at the limit for this tool.')
      } else {
        onChange(next, version)
        setRange(null)
        setMessage(tool === 'eraser' ? 'Passage erased. Undo restores it.' : 'Passage updated.')
      }
    } catch (cause) {
      if (controller && (controller.signal.aborted || request.current !== controller)) return
      // An older rejected request must not cancel the next stroke.
      if (cause instanceof Error && cause.name === 'AbortError') return
      setError(cause instanceof Error ? cause.message : 'Could not apply this tool.')
    } finally {
      if (controller && request.current === controller) { request.current = null; setPendingVersion(null) }
    }
  }

  function blockAt(element: Element | null) {
    const target = element?.closest<HTMLElement>('[data-paint-block]')
    return target && canvas.current?.contains(target) ? Number(target.dataset.paintBlock) : null
  }
  function startStroke(event: PointerEvent<HTMLDivElement>) {
    if (!canApply || pencil || tool === 'pencil' || event.button !== 0 || !event.isPrimary) return
    const index = blockAt(event.target as Element)
    if (index === null) return
    event.preventDefault()
    cancelRequest()
    setError('')
    setMessage('')
    const bounds = { firstIndex: index, lastIndex: index }
    stroke.current = { pointerId: event.pointerId, range: bounds }
    setRange(bounds)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function extendStroke(event: PointerEvent<HTMLDivElement>) {
    const active = stroke.current
    if (!active || active.pointerId !== event.pointerId) return
    const index = blockAt(document.elementFromPoint(event.clientX, event.clientY))
    if (index === null) return
    const next = { firstIndex: Math.min(active.range.firstIndex, index), lastIndex: Math.max(active.range.lastIndex, index) }
    if (next.firstIndex !== active.range.firstIndex || next.lastIndex !== active.range.lastIndex) {
      active.range = next
      setRange(next)
    }
  }
  function finishStroke(event: PointerEvent<HTMLDivElement>) {
    if (stroke.current?.pointerId !== event.pointerId) return
    extendStroke(event)
    const bounds = stroke.current.range
    stroke.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    void apply(bounds)
  }
  function changeRange(from: boolean, index: number) {
    cancelRequest()
    setPencil(null)
    setError('')
    setMessage('')
    setRange(from ? { firstIndex: index, lastIndex: Math.max(index, selection.lastIndex) }
      : { firstIndex: Math.min(index, selection.firstIndex), lastIndex: index })
  }

  return <div className="space-y-3" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); reset() } }}>
    <div role="group" aria-label="Paint tools" className="flex flex-wrap gap-1.5">
      {tools.map(({ id, label, icon: Icon }) => <Button key={id} type="button" size="sm" variant="outline" aria-pressed={tool === id}
        disabled={!editable || (isAi(id) && !rewrite)} className={cn('h-10 md:h-8', tool === id && 'border-accent-border bg-accent text-accent-foreground')}
        onClick={() => changeTool(id)}><Icon aria-hidden="true" />{label}</Button>)}
    </div>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <p className="text-xs leading-relaxed text-muted-foreground">{currentTool.hint}
        {isAi(tool) && ' Claude sees the whole draft for context and rewrites only your selection.'}
        {!rewrite && ' Human and Einstein require a connected computer with Claude.'}</p>
      {!!choices.length && <details className="w-full text-xs">
        <summary className="w-fit cursor-pointer py-1 font-medium">Choose a range</summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          {(['From block', 'Through block'] as const).map((label, i) => <label className="grid max-w-full gap-1" key={label}>
            <span>{label}</span><select aria-label={label} className="h-9 max-w-full rounded-md border bg-card px-2"
              disabled={!editable || (i === 1 && tool === 'pencil')} value={i === 0 || tool === 'pencil' ? selection.firstIndex : selection.lastIndex}
              onChange={event => changeRange(i === 0, Number(event.target.value))}>{choices.map(({ index, label: excerpt }, number) =>
                <option key={index} value={index}>{number + 1}. {excerpt}</option>)}</select></label>)}
          <Button type="button" size="sm" variant="outline" disabled={!canApply || busy} onClick={() => void apply(selection)}>Apply {currentTool.label}</Button>
        </div>
      </details>}
    </div>
    {error && <p role="alert" className="rounded-md border border-attention-border p-2 text-sm text-attention-foreground">{error}</p>}
    {busy ? <div role="status" className="flex items-center gap-2 text-sm">Claude is rewriting the selection…
      <Button type="button" size="sm" variant="ghost" onClick={reset}><XIcon />Cancel</Button></div>
      : message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
    <div ref={canvas} aria-label="Paint canvas" className="min-h-44 rounded-lg border bg-background/50 p-2"
      onPointerDown={startStroke} onPointerMove={extendStroke} onPointerUp={finishStroke}
      onPointerCancel={event => { if (stroke.current?.pointerId === event.pointerId) { stroke.current = null; setRange(null) } }}
      onLostPointerCapture={() => { if (stroke.current) { stroke.current = null; setRange(null) } }}>
      {!choices.length && <p className="p-3 text-sm text-muted-foreground">Write a passage in Edit to start painting.</p>}
      {blocks.map((block, index) => {
        if (block.kind === 'blank') return null
        if (pencil?.index === index) return <div key={index} data-pencil-form className="space-y-2 rounded-md border border-accent-border bg-card p-2">
          <label><span className="sr-only">Passage Markdown</span><Textarea autoFocus value={pencil.markdown} spellCheck={false} className="min-h-24 font-mono"
            onChange={event => setPencil({ index, markdown: editTextareaValue(pencil.markdown, event.currentTarget.value) })}
            onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); editPencil() } }}
            onBlur={event => { if (!event.currentTarget.closest('[data-pencil-form]')?.contains(event.relatedTarget as Node)) editPencil() }} /></label>
          <div className="flex gap-2" onMouseDown={event => event.preventDefault()}>
            <Button type="button" size="sm" onClick={editPencil}>Apply edit</Button>
            <Button type="button" size="sm" variant="ghost" onClick={reset}>Cancel</Button>
          </div>
        </div>
        const selected = !!range && index >= range.firstIndex && index <= range.lastIndex
        return <div key={index} data-paint-block={index} tabIndex={editable ? 0 : -1} role="button"
          aria-label={`${block.kind}: ${block.markdown.trim().slice(0, 85)}`} aria-pressed={selected} aria-disabled={!canApply}
          className={cn('relative rounded-md border border-transparent px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
            editable && 'cursor-crosshair hover:bg-accent/40', tool !== 'pencil' && editable && 'touch-none select-none',
            selected && 'border-accent-border bg-accent text-accent-foreground')}
          onClick={event => { if (tool === 'pencil' || event.detail === 0) void apply({ firstIndex: index, lastIndex: index }) }}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void apply({ firstIndex: index, lastIndex: index }) } }}>
          <PaintMarkdown markdown={block.markdown} />
        </div>
      })}
    </div>
  </div>
}
