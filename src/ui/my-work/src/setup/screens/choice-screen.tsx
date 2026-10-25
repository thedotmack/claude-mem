import { ArrowRightIcon, CheckIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { MemoryBranch } from '../setup-flow'
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
import { PageHeading } from './shared'

/** D4: big agent logos around the phone, left column then right column, top to bottom. */
const ORBIT = [['ChatGPT', chatgpt], ['Claude', claude], ['Gemini', gemini], ['OpenClaw', openclaw], ['Hermes', hermes], ['Grok Bot', grok], ['Muse', muse], ['Dot', dot]] as const

/** Step 3: At Home / On The Go (PROTO #route-choice). People already on Pro arrive with On The Go selected. */
export function ChoiceScreen({ branch, onChoose }: { branch: MemoryBranch; onChoose: (branch: MemoryBranch) => void }) {
  const [selected, setSelected] = useState<MemoryBranch>(branch)
  const submit = (event: FormEvent) => { event.preventDefault(); onChoose(selected) }
  return (
    <section aria-labelledby="choice-title">
      <PageHeading id="choice-title" title="Where do you want your memory?" />
      <form onSubmit={submit}>
        <fieldset className="memory-cards">
          <legend className="sr-only">Choose where to store and access your memory</legend>
          <label className="memory-card">
            <input className="memory-radio sr-only" type="radio" name="memory-option" value="home" aria-label="At Home, Free" checked={selected === 'home'} onChange={() => setSelected('home')} />
            <span className="selection-check" aria-hidden="true"><CheckIcon strokeWidth={3} /></span>
            <span className="memory-art memory-art-home"><img className="memory-artwork" src={atHome} alt="A modern silver desktop computer displaying the CMEM brain mark" width={840} height={840} /></span>
            <span className="card-copy"><span className="card-title">At Home</span><span className="card-price">Free</span></span>
          </label>
          <label className="memory-card is-go">
            <input className="memory-radio sr-only" type="radio" name="memory-option" value="go" aria-label="On The Go, 30 day free trial" checked={selected === 'go'} onChange={() => setSelected('go')} />
            <span className="selection-check" aria-hidden="true"><CheckIcon strokeWidth={3} /></span>
            <span className="memory-art memory-art-go">
              <img className="memory-artwork" src={onTheGo} alt="An iPhone displaying a memory feed with project context, decisions, and preferences" width={840} height={840} />
              <ul className="agent-orbit" aria-label="AI tools and agents">
                {ORBIT.map(([name, mark]) => <li key={name} className="agent"><img src={mark} alt="" width={62} height={62} /><span>{name}</span></li>)}
              </ul>
            </span>
            <span className="card-copy"><span className="card-title">On The Go</span><span className="card-price">30 day free trial</span></span>
          </label>
        </fieldset>
        <div className="actions is-centered"><button className="primary" type="submit">Continue <ArrowRightIcon aria-hidden="true" /></button></div>
      </form>
    </section>
  )
}
