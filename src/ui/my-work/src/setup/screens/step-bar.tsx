import { CheckIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { PROGRESS_STEP_OF_SCREEN, PROGRESS_STEP_WORDS, SETUP_PROGRESS_STEPS, progressStepState, type SetupFlowState, type RoutedSetupStep, type SetupProgressState } from '../setup-flow'

/**
 * Read after a bar step's name, so its state never rests on the mark alone. The current step says so through
 * aria-current; an upcoming one needs no words.
 */
const PROGRESS_STATE_WORDS: Record<SetupProgressState, string | null> = { done: 'completed', current: null, upcoming: null }

/**
 * The five-step bar on every setup screen, every step listed from the first (plan Phase 8). A step is ticked only
 * after the person has done it. Phones (setup.css, up to 560px wide) show the five marks and "Step N of 5" under them;
 * the step names are hidden there except to screen readers, which still hear every name and its state.
 */
export function SetupStepBar({ step, flow }: { step: RoutedSetupStep; flow: SetupFlowState }) {
  const { t } = useI18n()
  const currentIndex = SETUP_PROGRESS_STEPS.indexOf(PROGRESS_STEP_OF_SCREEN[step])
  return (
    <nav className="step-bar" aria-label={t('Setup progress')}>
      <ol>
        {SETUP_PROGRESS_STEPS.map((item) => {
          const state = progressStepState(item, step, flow)
          const stateWords = PROGRESS_STATE_WORDS[state]
          return (
            <li key={item} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="step-mark" aria-hidden="true">{state === 'done' && <CheckIcon strokeWidth={3} />}</span>
              <span className="step-name">{t(PROGRESS_STEP_WORDS[item])}</span>
              {stateWords && <span className="sr-only"> ({t(stateWords)})</span>}
            </li>
          )
        })}
      </ol>
      <p className="step-count" aria-hidden="true">{interpolate(t('Step {number} of {total}'), { number: currentIndex + 1, total: SETUP_PROGRESS_STEPS.length })}</p>
    </nav>
  )
}
