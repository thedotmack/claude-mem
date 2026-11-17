import { useEffect, useRef, useState } from 'react'
import { CmemMark } from '@/components/brand'
import { useI18n } from '@/lib/i18n'
import type { SetupTool } from '../setup-data'
import { launchLengthMs } from '../setup-flow'
import { prefersReducedMotion } from '../format'
import { SetupActions, SetupButton, ToolMark, type SetupBack } from './shared'

/**
 * Step 7 (PROTO finish-setup.js `animateLaunch`): the picked tools, joined to the brain, move into it, then the
 * workspace opens. Two moving things at most (rule 8, E10): the tools as one group and the brain; the sparkle field is
 * gone. Skip works from the first frame, so the wait never holds anyone (review `no-blocking-animation`). Reduced motion
 * never mounts this step (the page skips to the workspace).
 *
 * The launch takes as long as it did before Phase 8 for the tools picked (launchLengthMs), and plays once: its length is
 * fixed when it starts, and a worker update while it plays (a new tools list with the same tools) does not restart it.
 */
export function LaunchScreen({ tools, back, onDone }: { tools: SetupTool[]; back?: SetupBack | null; onDone: () => void }) {
  const { t } = useI18n()
  const toolsRef = useRef<HTMLUListElement>(null)
  const brainRef = useRef<HTMLSpanElement>(null)
  const doneRef = useRef(onDone)
  // Set once, from the tools picked when the launch starts.
  const [lengthMs] = useState(() => launchLengthMs(tools.length))
  useEffect(() => { doneRef.current = onDone })
  useEffect(() => {
    if (prefersReducedMotion()) { doneRef.current(); return }
    const animations = [
      toolsRef.current!.animate([
        { transform: 'none', opacity: 1 },
        { transform: 'none', opacity: 1, offset: 0.35 },
        { transform: 'translateY(56px) scale(.55)', opacity: 0 },
      ], { duration: lengthMs, easing: 'cubic-bezier(.22,.8,.2,1)', fill: 'forwards' }),
      brainRef.current!.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12)', offset: 0.75 }, { transform: 'scale(1)' }], { duration: lengthMs, easing: 'ease-in-out', fill: 'forwards' }),
    ]
    let cancelled = false
    Promise.all(animations.map((animation) => animation.finished)).then(() => { if (!cancelled) doneRef.current() }, () => {})
    return () => { cancelled = true; animations.forEach((animation) => animation.cancel()) }
  }, [lengthMs])
  return (
    <section aria-labelledby="launch-title">
      <div className="launch-stage" aria-hidden="true">
        <ul ref={toolsRef} className="launch-tools">
          {tools.map((tool) => <li key={tool.id}><ToolMark id={tool.id} name={tool.name} /><span>{tool.name}</span></li>)}
        </ul>
        <span ref={brainRef} className="launch-brain"><CmemMark className="size-full" /></span>
      </div>
      <div className="page-heading">
        <h1 id="launch-title" tabIndex={-1}>{t('Opening your memory workspace')}</h1>
        <p className="lead" role="status" aria-live="polite">{t('Bringing your tools and memory together.')}</p>
      </div>
      <SetupActions back={back}>
        <SetupButton look="outline" onClick={() => doneRef.current()}>{t('Skip')}</SetupButton>
      </SetupActions>
    </section>
  )
}
