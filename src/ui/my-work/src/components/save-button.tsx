import { useState, type ComponentProps } from 'react'
import { StatefulButton } from '@/components/aceternity/stateful-button'
import { STATEFUL_BUTTON_STATE, type StatefulButtonState } from '@/components/aceternity/stateful-button-state'
import { useI18n } from '@/lib/i18n'
import type { Translate } from '@/components/bits'

/** A caller's own words for what its action does, when it is not a save (setup's Copy URL copies). */
type ActionWords = {
  /** The label while the action runs, in place of "Saving…" ("Copying…"). */
  savingLabel?: string
  /** The label, and what a screen reader hears, after the action worked, in place of "Saved" ("Copied"). */
  savedLabel?: string
  /**
   * What a screen reader hears when the action did not work, in place of "Not saved" ("Not copied"). The button shows
   * its own label again, so it can be pressed to try again; the caller says why under it. `null`: the caller's line under
   * it is the announcement (an alert in its own words), so the button says nothing and the failure is heard once.
   */
  notSavedLabel?: string | null
}

/**
 * What a save button says in each state (c-save-button: "Saving…" and "Saved" are words, not only an icon), on its
 * label and to a screen reader, unless the caller words its action itself. Each entry words its own literal text, so
 * the catalog test sees it. `label`: the words on the button, null for the caller's own label. `spoken`: what a screen
 * reader hears when the state is reached. Saving is said by the label and aria-busy.
 */
const SAVE_BUTTON_WORDS: Record<StatefulButtonState, {
  label: ((t: Translate, own: ActionWords) => string) | null
  spoken: ((t: Translate, own: ActionWords) => string | null) | null
}> = {
  rest: { label: null, spoken: null },
  saving: { label: (t, own) => own.savingLabel ?? t('Saving…'), spoken: null },
  saved: { label: (t, own) => own.savedLabel ?? t('Saved'), spoken: (t, own) => own.savedLabel ?? t('Saved') },
  'not-saved': { label: null, spoken: (t, own) => own.notSavedLabel === null ? null : own.notSavedLabel ?? t('Not saved') },
}

type SaveButtonProps = Omit<ComponentProps<typeof StatefulButton>, 'stateLabels' | 'onStateChange'> & ActionWords

/**
 * A save you can watch, in five looks at one width (c-save-button): rest; keyboard focus (the caller's focus ring);
 * saving (a turning ring and "Saving…", aria-busy, a second press ignored); saved (a check and "Saved", announced,
 * until the next press); not saved (the caller's label again, and "Not saved" announced). The icon slot is kept in every
 * state, with or without the caller's `icon`, so the words never move.
 *
 * The action resolves `false` when it did not save, and the caller shows why under the button, with the raw cause
 * folded under Details (G17); anything else when it saved. The look is the caller's (Button variant classes or setup
 * CSS). The two screen-reader regions are siblings of the button and take no room.
 */
export function SaveButton({ savingLabel, savedLabel, notSavedLabel, ...props }: SaveButtonProps) {
  const { t } = useI18n()
  const [state, setState] = useState<StatefulButtonState>(STATEFUL_BUTTON_STATE.rest)
  const own: ActionWords = { savingLabel, savedLabel, notSavedLabel }
  const stateLabels = Object.fromEntries(Object.values(STATEFUL_BUTTON_STATE).flatMap((each) => {
    const label = SAVE_BUTTON_WORDS[each].label
    return label ? [[each, label(t, own)]] : []
  }))
  const spoken = SAVE_BUTTON_WORDS[state].spoken?.(t, own) ?? ''
  return (
    <>
      <StatefulButton stateLabels={stateLabels} onStateChange={setState} {...props} />
      {/* Polite: "Saved". The region is always there, so the change to it is what a screen reader announces. */}
      <span role="status" className="sr-only">{state === STATEFUL_BUTTON_STATE.saved ? spoken : ''}</span>
      {state === STATEFUL_BUTTON_STATE.notSaved && spoken && <span role="alert" className="sr-only">{spoken}</span>}
    </>
  )
}
