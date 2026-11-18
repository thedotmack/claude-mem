// A request's next step in the reader's words (components/bits.tsx NextMove, the focus board, a focus page's summary).
// Pure, with .ts imports, so `node --test` loads it.
import { interpolate } from '../../../i18n/locale.ts'
import type { NextStepKind } from '../data.ts'
import type { ShownNextStep } from './to-work-model.ts'

/**
 * A step in the reader's words, by its kind (data.ts NextStepKind), each in its own t() call so the catalog test reads
 * every one: a recorded step as its agent wrote it, one that unblocks a blocked request after "Unblock:", and a checked
 * result's "Ship it" (the mapper wrote the last two in English before 16.0.0).
 */
const NEXT_STEP_WORDS: Record<NextStepKind, (step: string, t: (text: string) => string) => string> = {
  recorded: (step) => step,
  unblock: (step, t) => interpolate(t('Unblock: {step}'), { step }),
  ship: (_step, t) => t('Ship it'),
}

/** What a shown step says (live/to-work-model.ts nextStepShown), in the reader's words. */
export function nextStepWords(shown: Extract<ShownNextStep, { kind: 'step' }>, t: (text: string) => string): string {
  return NEXT_STEP_WORDS[shown.step](shown.text ?? '', t)
}
