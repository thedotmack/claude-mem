import { BoxIcon, TerminalIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SetupTool } from '../setup-data'
import chatgptMark from '../assets/agents/chatgpt.webp'
import claudeMark from '../assets/agents/claude.webp'
import geminiMark from '../assets/agents/gemini.webp'

/** Every screen's title block. The page moves focus to the h1 on each step change. */
export function PageHeading({ id, title, lead }: { id: string; title: ReactNode; lead?: ReactNode }) {
  return (
    <div className="page-heading">
      <h1 id={id} tabIndex={-1}>{title}</h1>
      {lead && <p className="lead">{lead}</p>}
    </div>
  )
}

const MARK_IMAGES = { chatgpt: chatgptMark, claude: claudeMark, gemini: geminiMark } as const

export function ToolMark({ mark }: { mark: SetupTool['mark'] }) {
  if (mark === 'terminal') return <span className="tool-mark is-terminal" aria-hidden="true"><TerminalIcon /></span>
  if (mark === 'codex') return <span className="tool-mark is-codex" aria-hidden="true"><BoxIcon /></span>
  return <span className="tool-mark" aria-hidden="true"><img src={MARK_IMAGES[mark]} alt="" width={34} height={34} /></span>
}
