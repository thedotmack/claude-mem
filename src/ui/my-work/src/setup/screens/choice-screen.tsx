import { ArrowRightIcon, CheckIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { interpolate, useI18n } from '@/lib/i18n'
import { CLOUD_SYNC_OFFER_TERMS, DEFAULT_CLOUD_SYNC_OFFER, SETUP_CLOUD_SYNC_OFFERS, type SetupCloudSyncOffer } from '../../../../../shared/setup-funnel.ts'
import type { MemoryBranch } from '../setup-flow'
import { money } from '../format'
import atHome from '../assets/at-home-modern-computer.webp'
import onTheGo from '../assets/on-the-go-iphone-feed.webp'
import chatgpt from '../assets/agents/chatgpt.webp'
import claude from '../assets/agents/claude.webp'
import gemini from '../assets/agents/gemini.webp'
import openclaw from '../assets/agents/openclaw.webp'
import hermes from '../assets/agents/hermes.webp'
import grok from '../assets/agents/grok-bot.webp'
import muse from '../assets/agents/muse-meta.webp'
import dot from '../assets/agents/dot.webp'
import { PageHeading, SetupActions, SetupButton, type SetupBack } from './shared'

/** D4: big agent logos around the phone, left column then right column, top to bottom. */
const ORBIT = [['ChatGPT', chatgpt], ['Claude', claude], ['Gemini', gemini], ['OpenClaw', openclaw], ['Hermes', hermes], ['Grok Bot', grok], ['Muse', muse], ['Dot', dot]] as const
/**
 * The orbit's first names, written out in the card's line; the rest are counted ("and 5 more"). Reason (E5,
 * readable-font-size, whose own example names three: "ChatGPT, Claude, Gemini and 5 more"): measured 2026-11-16, three
 * is the most that keeps the line on one row at 1440 (410px wide; a fourth name wraps it). At 390 it takes two rows.
 */
const ORBIT_NAMED = 3

/** Each option's name, as its card and the Continue button say it (C6: "On The Go" is the storage choice). */
const BRANCH_NAMES: Record<MemoryBranch, string> = { home: 'At Home', go: 'On The Go' }
const OFFER_LABELS: Record<SetupCloudSyncOffer, string> = {
  cloud_sync_monthly: 'Monthly · $0 today, then $12/month after 30 days',
  cloud_sync_annual: 'Annual · $99 today, then $99/year. No trial.',
}

/**
 * Step 3: At Home / On The Go (PROTO #route-choice). People already on Pro arrive with On The Go selected. The cards
 * are real radio buttons with four plain looks (E13: rest, hover, keyboard focus, selected), so the pointer light is gone.
 */
export function ChoiceScreen({ branch, cloudSyncOffer = DEFAULT_CLOUD_SYNC_OFFER, alreadyPro = false, back, onChoose }: { branch: MemoryBranch; cloudSyncOffer?: SetupCloudSyncOffer; alreadyPro?: boolean; back?: SetupBack | null; onChoose: (branch: MemoryBranch, cloudSyncOffer: SetupCloudSyncOffer) => void }) {
  const { t } = useI18n()
  const [selected, setSelected] = useState<MemoryBranch>(branch)
  const [offer, setOffer] = useState<SetupCloudSyncOffer>(cloudSyncOffer)
  const submit = (event: FormEvent) => { event.preventDefault(); onChoose(selected, offer) }
  const goTools = interpolate(t('Also works with {names} and {count} more'), { names: ORBIT.slice(0, ORBIT_NAMED).map(([name]) => name).join(', '), count: ORBIT.length - ORBIT_NAMED })
  return (
    <section aria-labelledby="choice-title">
      <PageHeading id="choice-title" title={t('Where do you want your memory?')} />
      <form onSubmit={submit}>
        <fieldset className="memory-cards">
          <legend className="sr-only">{t('Choose where to store and access your memory')}</legend>
          <label className="memory-card">
            <input className="memory-radio sr-only" type="radio" name="memory-option" value="home" aria-label={t('At Home, Free')} checked={selected === 'home'} onChange={() => setSelected('home')} />
            <span className="memory-card-marks" aria-hidden="true"><span className="radio-mark"><CheckIcon strokeWidth={3} /></span><span className="selected-badge">{t('Selected')}</span></span>
            <span className="memory-art memory-art-home"><img className="memory-artwork" src={atHome} alt={t('A modern silver desktop computer displaying the CMEM brain mark')} width={840} height={840} loading="eager" decoding="async" /></span>
            <span className="card-copy">
              <span className="card-title">{t(BRANCH_NAMES.home)}</span>
              <span className="card-price">{t('Free')}</span>
              <span className="card-gets">
                <span><CheckIcon aria-hidden="true" />{t('Memory stays on this computer')}</span>
                <span><CheckIcon aria-hidden="true" />{t('Your Claude account writes the memories')}</span>
                <span><CheckIcon aria-hidden="true" />{t('No claude-mem account needed')}</span>
              </span>
            </span>
          </label>
          <label className="memory-card is-go">
            <input className="memory-radio sr-only" type="radio" name="memory-option" value="go" aria-label={t(alreadyPro ? 'On The Go, keep your existing plan' : offer === 'cloud_sync_annual' ? 'On The Go, $99 a year, no trial' : 'On The Go, 30 day free trial, then $12 a month')} checked={selected === 'go'} onChange={() => setSelected('go')} />
            <span className="memory-card-marks" aria-hidden="true"><span className="radio-mark"><CheckIcon strokeWidth={3} /></span><span className="selected-badge">{t('Selected')}</span></span>
            <span className="memory-art memory-art-go">
              <img className="memory-artwork" src={onTheGo} alt={t('An iPhone displaying a memory feed with project context, decisions, and preferences')} width={840} height={840} loading="eager" decoding="async" />
              <ul className="agent-orbit" aria-label={t('AI tools and agents')}>
                {ORBIT.map(([name, mark]) => <li key={name} className="agent"><img src={mark} alt="" width={62} height={62} loading="eager" decoding="async" /><span>{name}</span></li>)}
              </ul>
            </span>
            <span className="card-copy">
              <span className="card-title">{t(BRANCH_NAMES.go)}</span>
              <span className="card-price">{alreadyPro ? t('Keep your existing plan') : offer === 'cloud_sync_annual'
                ? t('$99 today · $99/year · No trial')
                : interpolate(t('30 day free trial, then {amount} a month'), { amount: money(CLOUD_SYNC_OFFER_TERMS.cloud_sync_monthly.cents) })}</span>
              <span className="card-gets">
                <span><CheckIcon aria-hidden="true" />{t('Your memory on every device')}</span>
                <span><CheckIcon aria-hidden="true" />{goTools}</span>
                <span><CheckIcon aria-hidden="true" />{t('Keep your existing memory provider')}</span>
              </span>
            </span>
          </label>
        </fieldset>
        {selected === 'go' && !alreadyPro && <fieldset className="cloud-sync-offers">
          <legend>{t('Choose your Cloud Sync plan')}</legend>
          {SETUP_CLOUD_SYNC_OFFERS.map(value => <label key={value} className="cloud-sync-offer">
            <input type="radio" name="cloud-sync-offer" value={value} checked={offer === value} onChange={() => setOffer(value)} />
            <span>{t(OFFER_LABELS[value])}</span>
          </label>)}
          <p>{t('Cloud Sync connects your devices. Hosted tokens are optional and sold separately after setup.')}</p>
        </fieldset>}
        <SetupActions back={back}>
          <SetupButton type="submit">{interpolate(t('Continue with {option}'), { option: t(BRANCH_NAMES[selected]) })} <ArrowRightIcon aria-hidden="true" /></SetupButton>
        </SetupActions>
      </form>
    </section>
  )
}
