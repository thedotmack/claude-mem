import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { ArrowUpRightIcon, ExpandIcon } from 'lucide-react'
import type { ReviewStackCard, ReviewStackMode } from '../../../../shared/review-stack.ts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n, interpolate } from '@/lib/i18n'
import { originalHttps, REVIEW_STACK_URL } from '@/live/review-stack-client'
import { GROUP_HOLD_MS, horizontalTravel } from '@/live/review-stack-deck'

/** Private thumbnails need the same fetch wrapper as the deck, even on the local worker. */
function usePreview(card: ReviewStackCard, retry: number) {
  const candidate = card.preview ?? card.imageData
  const privatePath = candidate === `${REVIEW_STACK_URL}/media/${encodeURIComponent(card.id)}` ? candidate : undefined
  const [result, setResult] = useState<{ path: string; url?: string; failed?: boolean }>()
  useEffect(() => {
    if (!privatePath) return
    const controller = new AbortController()
    let objectUrl: string | undefined
    void fetch(privatePath, { signal: controller.signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error' }).then(async response => {
      if (!response.ok) throw new Error('Preview unavailable')
      const image = await response.blob()
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(image)
      setResult({ path: privatePath, url: objectUrl })
    }).catch(() => { if (!controller.signal.aborted) setResult({ path: privatePath, failed: true }) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [privatePath, retry])
  if (privatePath) return result?.path === privatePath ? result : { url: undefined, failed: false }
  const inline = candidate && /^data:image\/(?:png|jpeg|webp);base64,/i.test(candidate)
  return { url: inline ? candidate : originalHttps(candidate), failed: false }
}

function CardOriginal({ card }: { card: ReviewStackCard }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const [retry, setRetry] = useState(0)
  const [broken, setBroken] = useState(false)
  const preview = usePreview(card, retry)
  const source = originalHttps(card.source)
  return <>
    {preview.url && !broken && <button type="button" className="stack-preview" aria-label={interpolate(t('Enlarge {title}'), { title: card.title })} onClick={() => setExpanded(true)}>
      <img src={preview.url} alt={card.title} decoding="async" draggable={false} referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      <ExpandIcon aria-hidden="true" className="stack-expand" />
    </button>}
    {(preview.failed || broken) && <p className="flex items-center gap-2 text-sm">{t('Preview unavailable.')} <Button size="sm" variant="outline" onClick={() => { setBroken(false); setRetry(value => value + 1) }}>{t('Retry preview')}</Button></p>}
    {card.excerpt && <blockquote className="stack-excerpt" dir="auto">{card.excerpt}</blockquote>}
    {source && <a className="stack-source" href={source} target="_blank" rel="noreferrer">{t('Open original')}<ArrowUpRightIcon size={16} aria-hidden="true" /></a>}
    {expanded && preview.url && <Dialog open onOpenChange={open => { if (!open) setExpanded(false) }}>
      <DialogContent className="max-h-[92svh] overflow-auto sm:max-w-4xl" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{card.title}</DialogTitle></DialogHeader>
        <img className="mx-auto max-h-[72svh] max-w-full object-contain" alt={card.title} src={preview.url} referrerPolicy="no-referrer" />
      </DialogContent>
    </Dialog>}
  </>
}

type Press = { id: number | 'keyboard'; startX: number; startY: number; startedAt: number; width: number; button: boolean }

export function ReviewCard({ card, mode, disabled, onSeen, onGroup, onBrowse, children }: {
  card: ReviewStackCard; mode: ReviewStackMode; disabled: boolean; onSeen: () => void; onGroup: () => void
  onBrowse: (step: number) => void; children: ReactNode
}) {
  const { t } = useI18n()
  const press = useRef<Press | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const consumed = useRef(false)
  const [holding, setHolding] = useState(false)
  const [travel, setTravel] = useState(0)
  const callbacks = useRef({ onSeen, onGroup, onBrowse })
  useLayoutEffect(() => { callbacks.current = { onSeen, onGroup, onBrowse } }, [onSeen, onGroup, onBrowse])

  function disarm() { clearTimeout(timer.current); timer.current = undefined; setHolding(false) }
  function cancel() { disarm(); press.current = null; setTravel(0) }
  function abandon() { if (press.current) consumed.current = true; cancel() }
  function arm() {
    if (timer.current !== undefined) return
    setHolding(true)
    timer.current = setTimeout(() => {
      if (!press.current) return
      // A completed bulk gesture consumes its release, even if another card appears under the pointer.
      abandon()
      if (!document.hidden) callbacks.current.onGroup()
    }, GROUP_HOLD_MS)
  }
  useLayoutEffect(() => { abandon() }, [card.id, disabled, mode])
  useEffect(() => {
    const hidden = () => { if (document.hidden) abandon() }
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') abandon() }
    const second = (event: globalThis.PointerEvent) => { if (press.current && event.pointerId !== press.current.id) abandon() }
    window.addEventListener('blur', abandon)
    document.addEventListener('visibilitychange', hidden)
    document.addEventListener('keydown', escape)
    document.addEventListener('pointerdown', second, true)
    return () => {
      clearTimeout(timer.current)
      window.removeEventListener('blur', abandon)
      document.removeEventListener('visibilitychange', hidden)
      document.removeEventListener('keydown', escape)
      document.removeEventListener('pointerdown', second, true)
    }
  }, [])
  function pointerDown(event: PointerEvent<HTMLElement>) {
    if (disabled || !event.isPrimary || event.button !== 0) return
    consumed.current = false
    const target = event.target as Element
    const button = !!target.closest('[data-review-seen]')
    if (!button && target.closest('a,input,textarea,select,button:not(.stack-preview)')) return
    press.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, startedAt: event.timeStamp, width: event.currentTarget.clientWidth, button }
    if (button) { target.setPointerCapture(event.pointerId); arm() }
  }
  function pointerMove(event: PointerEvent<HTMLElement>) {
    const active = press.current
    if (active?.id !== event.pointerId) return
    const x = event.clientX - active.startX
    const y = event.clientY - active.startY
    if (active.button) { if (Math.hypot(x, y) > 15) abandon(); return }
    if (Math.abs(x) > 10 && Math.abs(x) > Math.abs(y) * 1.15) {
      event.currentTarget.setPointerCapture(event.pointerId)
      setTravel(Math.max(-44, Math.min(44, x * 0.3)))
    }
    if (mode === 'work' && x > 0 && horizontalTravel(x, y, active.width)) arm()
    else if (timer.current) disarm()
  }
  function pointerUp(event: PointerEvent<HTMLElement>) {
    const active = press.current
    if (active?.id !== event.pointerId) return
    const x = event.clientX - active.startX
    const y = event.clientY - active.startY
    cancel()
    if (active.button) { if (Math.hypot(x, y) > 15) consumed.current = true; return }
    const flick = Math.abs(x) >= 26 && Math.abs(x) > Math.abs(y) * 1.15 && Math.abs(x) / Math.max(1, event.timeStamp - active.startedAt) >= 0.5
    if (!flick && !horizontalTravel(x, y, active.width)) return
    consumed.current = true
    if (mode === 'browse') callbacks.current.onBrowse(x < 0 ? 1 : -1)
    else if (x > 0) callbacks.current.onSeen()
  }
  function keyDown(event: KeyboardEvent<HTMLElement>) {
    if (disabled || event.metaKey || event.altKey || event.ctrlKey) return
    const target = event.target as Element
    if (target.closest('[data-review-seen]') && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      if (event.repeat || press.current) return
      consumed.current = false
      press.current = { id: 'keyboard', startX: 0, startY: 0, startedAt: event.timeStamp, width: 0, button: true }
      arm()
    } else if (event.target === event.currentTarget && !event.repeat) {
      if (mode === 'browse' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); onBrowse(event.key === 'ArrowRight' ? 1 : -1) }
      if (mode === 'work' && event.key === 'ArrowRight') { event.preventDefault(); onSeen() }
    }
  }

  return <article className="stack-card" tabIndex={0} aria-label={card.title}
    style={travel ? { transform: `translateX(${travel}px)` } : undefined}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={abandon}
    onLostPointerCapture={event => { if (press.current && !event.currentTarget.hasPointerCapture(event.pointerId)) abandon() }} onPointerLeave={event => { if (press.current && !event.currentTarget.hasPointerCapture(event.pointerId) && !press.current.button) abandon() }}
    onClickCapture={event => { if (consumed.current) { consumed.current = false; event.preventDefault(); event.stopPropagation() } }}
    onKeyDown={keyDown} onKeyUp={event => { if (press.current?.id === 'keyboard' && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); cancel(); onSeen() } }}
    onBlur={() => { if (press.current?.id === 'keyboard') abandon() }}>
    <CardOriginal key={card.id} card={card} />
    <div className="stack-copy"><span className="text-sm font-medium text-muted-foreground" dir="auto">{card.focus}</span>
      <h2 className="text-xl font-semibold leading-tight" dir="auto">{card.title}</h2>
      <p dir="auto">{card.what}</p><p className="text-sm text-muted-foreground" dir="auto">{card.context}</p>
    </div>
    {holding && <p className="stack-hold" role="status">{interpolate(t('Hold to mark {focus} seen'), { focus: card.focus })}<i aria-hidden="true" /></p>}
    {children}
  </article>
}
