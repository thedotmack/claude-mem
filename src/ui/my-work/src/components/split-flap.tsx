// A status label on split-flap tiles, one tile per character and exactly as wide as the label: a line on a
// departures board (decision 2, R4.4). When the label changes (and when it first shows) each tile riffles through
// a few letters, left to right, and lands; then it stops. The riffle writes the tiles' text directly, without
// re-rendering React, so a hundred labels flipping at once stay cheap. Reduced motion: the tiles show the label, read
// as it is now (lib/use-media.ts usePrefersReducedMotion), so a setting changed mid-riffle lands the letters at once.
// A word never breaks; a label too long for its line (Turkish's "Done, not checked") wraps between words, as the
// status pill's word does at rest.
import { useEffect, useRef } from 'react'
import { usePrefersReducedMotion } from '@/lib/use-media'
import { cn } from '@/lib/utils'

const FLAP_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
// About a real board's flap rate; four to eight flaps a tile, so the whole label lands in under a second.
const FLAP_MS = 55
const MIN_FLAPS = 4
const EXTRA_FLAPS = 4
// Each tile starts one flap after the tile to its left, so the line settles from left to right.
const TILE_STAGGER_FLAPS = 1
// Each flap drops the tile's top half into place.
const FOLD: Keyframe[] = [{ transform: 'rotateX(70deg)' }, { transform: 'rotateX(0deg)' }]
const FOLD_TIMING: KeyframeAnimationOptions = { duration: FLAP_MS, easing: 'ease-in' }

/** The label's words, each with where it starts among the letters (a space has no tile). */
function wordsOf(letters: string[]): { start: number; word: string[] }[] {
  const words: { start: number; word: string[] }[] = []
  letters.forEach((letter, index) => {
    if (letter === ' ') return
    const last = words.at(-1)
    if (last && last.start + last.word.length === index) last.word.push(letter)
    else words.push({ start: index, word: [letter] })
  })
  return words
}

export function SplitFlapText({ text, className, tileClassName }: { text: string; className?: string; tileClassName?: string }) {
  const reduceMotion = usePrefersReducedMotion()
  const tiles = useRef<(HTMLSpanElement | null)[]>([])
  const letters = text.toUpperCase().split('')
  useEffect(() => {
    const letters = text.toUpperCase().split('')
    const elements = tiles.current.slice(0, letters.length)
    if (reduceMotion) { elements.forEach((element, index) => { if (element) element.textContent = letters[index] === ' ' ? '\u00A0' : letters[index] }); return }
    // Flaps each tile shows before its own letter: its stagger, then a few random letters.
    const landsAt = letters.map((_, index) => index * TILE_STAGGER_FLAPS + MIN_FLAPS + Math.floor(Math.random() * EXTRA_FLAPS))
    const last = Math.max(...landsAt)
    // Flaps count from the clock, not from ticks, so a busy frame never makes a label land late.
    const start = performance.now()
    const shown = letters.map(() => -1)
    const timer = setInterval(() => {
      const flap = Math.floor((performance.now() - start) / FLAP_MS) + 1
      elements.forEach((element, index) => {
        if (!element || letters[index] === ' ' || shown[index] >= landsAt[index]) return
        const step = Math.min(flap, landsAt[index])
        if (step === shown[index]) return
        shown[index] = step
        element.textContent = step >= landsAt[index] ? letters[index] : FLAP_LETTERS[Math.floor(Math.random() * FLAP_LETTERS.length)]
        // The fold runs as a Web Animation, so restarting it never forces a layout.
        element.animate(FOLD, FOLD_TIMING)
      })
      if (flap >= last) clearInterval(timer)
    }, FLAP_MS)
    return () => clearInterval(timer)
  }, [text, reduceMotion])
  return (
    <span className={cn('inline-flex min-w-0', className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="inline-flex min-w-0 flex-wrap gap-x-[0.3em] gap-y-0.5">
        {wordsOf(letters).map(({ start, word }) => (
          <span key={start} className="inline-flex">
            {word.map((letter, offset) => (
              <span key={offset} ref={(element) => { tiles.current[start + offset] = element }} className={cn('split-flap-tile', tileClassName)}>
                {reduceMotion ? letter : '\u00A0'}
              </span>
            ))}
          </span>
        ))}
      </span>
    </span>
  )
}
