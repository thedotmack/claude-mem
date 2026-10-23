import { ArrowRightIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { AgentMark } from '@/components/brand'
import { formatPromptDay } from '@/lib/prompt-time'
import type { RevealSets, SetupScanAgent } from '../setup-data'
import { joinNames } from '../format'
import { PageHeading } from './shared'

const timesLabel = (times: number) => times === 1 ? 'asked once' : `asked ${times}×`

/** One of the three sets. `null` items: still being extracted, so it shows placeholders until they land. */
function RevealSet<T>({ title, items, render }: { title: string; items: T[] | null; render: (item: T) => ReactNode }) {
  if (items && items.length === 0) return null
  return (
    <section className={items ? 'reveal-set is-landed' : 'reveal-set'} aria-labelledby={`reveal-${title}`} aria-busy={!items}>
      <h2 id={`reveal-${title}`}>{title}</h2>
      <ol>
        {items ? items.map(render) : [0, 1, 2].map((index) => <li key={index} className="reveal-card is-pending" aria-hidden="true" />)}
      </ol>
    </section>
  )
}

/** Step 2: Work, Goals and Rules read from the person's own prompts. Live: each set lands as its extraction finishes; Continue never waits. */
export function RevealScreen({ agents, reveal, onContinue }: { agents: SetupScanAgent[]; reveal: RevealSets; onContinue: () => void }) {
  const withPrompts = agents.filter((agent) => agent.prompts > 0)
  const promptCount = withPrompts.reduce((sum, agent) => sum + agent.prompts, 0)
  return (
    <section aria-labelledby="reveal-title">
      <PageHeading id="reveal-title" title="Claude-Mem already knows your work."
        lead={promptCount > 0 ? `From ${promptCount.toLocaleString('en-US')} prompts across ${joinNames(withPrompts.map((agent) => agent.label))}: what you’re working on, what you’re after, and how you like things done.` : undefined} />
      <div className="reveal-sets">
        <RevealSet title="Work" items={reveal.work} render={(work) => (
          <li key={work.id} className="reveal-card">
            <span className="lead-icon" aria-hidden="true"><AgentMark tool={work.agent} /></span>
            <div>
              <p className="title">{work.title}</p>
              <p className="meta">Last active {formatPromptDay(work.lastActiveAt)}</p>
              {work.progressPercent !== undefined && <div className="bar" role="img" aria-label={`${work.progressPercent}% done`}><span style={{ width: `${work.progressPercent}%` }} /></div>}
            </div>
          </li>
        )} />
        <RevealSet title="Goals" items={reveal.goals} render={(goal) => (
          <li key={goal.id} className="reveal-card">
            <span className="lead-icon" aria-hidden="true">{goal.rank}</span>
            <div>
              <p className="title">{goal.title}</p>
              <p className="meta">{timesLabel(goal.timesAsked)}, last {formatPromptDay(goal.latestAt)}</p>
            </div>
          </li>
        )} />
        <RevealSet title="Rules" items={reveal.rules} render={(rule) => (
          <li key={rule.id} className="reveal-card">
            <span className="lead-icon" aria-hidden="true">“</span>
            <div>
              <p className="title">{rule.text}</p>
              <p className="quote">“{rule.quote}” · {formatPromptDay(rule.quotedAt)}</p>
            </div>
          </li>
        )} />
      </div>
      <div className="actions is-centered">
        <button type="button" className="primary" onClick={onContinue}>Continue <ArrowRightIcon aria-hidden="true" /></button>
      </div>
    </section>
  )
}
