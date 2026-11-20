import { ArrowLeftIcon, InfoIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { interpolate, useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { SetupFailure, SetupFailureKind } from '../setup-data'
import type { SetupBackWait } from '../setup-flow'
import openaiMark from '../assets/agents/chatgpt.webp'
import claudeMark from '../assets/agents/claude.webp'
import geminiMark from '../assets/agents/gemini.webp'
import grokMark from '../assets/agents/grok-bot.webp'
import hermesMark from '../assets/agents/hermes.webp'
import openclawMark from '../assets/agents/openclaw.webp'

/** Every screen's title block: one title size and one lead size per width (setup.css). The page moves focus to the h1. */
export function PageHeading({ id, title, lead }: { id: string; title: ReactNode; lead?: ReactNode }) {
  return (
    <div className="page-heading">
      <h1 id={id} tabIndex={-1}>{title}</h1>
      {lead && <p className="lead">{lead}</p>}
    </div>
  )
}

/**
 * The tools whose own logo is a file in setup/assets/agents: claude.webp is Claude's (Claude.ai) and chatgpt.webp is
 * ChatGPT's, as the marks were assigned before Phase 8. No two tools share a logo (E12): Claude Code and Codex, which
 * borrowed those two, and every tool without a file show the letters of their name in a neutral tile. No invented logos.
 */
const TOOL_LOGOS: Partial<Record<string, string>> = {
  'claude-ai': claudeMark, chatgpt: openaiMark,
  'gemini-cli': geminiMark, openclaw: openclawMark, hermes: hermesMark, 'grok-bot': grokMark,
}

/** Words that name a tool's form rather than the tool: "Codex CLI" is Codex, "Devin CLI / Desktop" is Devin. */
const FORM_WORDS = new Set(['cli', 'desktop'])

/**
 * Two letters that tell the tools apart: the initials of a two-word name ("Claude Code" → "CC", "DeepSeek Harness" →
 * "DH"), otherwise the first letter and the next consonant ("Codex" → "Cd", "Copilot" → "Cp", "Cursor" → "Cr"), so
 * tools sharing a first letter still differ. A tool named two ways ("Codex", "Codex CLI") keeps one mark.
 */
function nameLetters(name: string): string {
  const words = name.trim().split(/[\s/]+/).filter((word) => word && !FORM_WORDS.has(word.toLowerCase()))
  if (words.length > 1) return `${words[0][0]}${words[1][0]}`.toUpperCase()
  const word = words[0] || name.trim() || '?'
  const next = word.slice(1).match(/[^aeiouy\W_]/i)?.[0] ?? word.slice(1, 2)
  return `${word[0].toUpperCase()}${next.toLowerCase()}`
}

/** One mark per tool, the same on every screen (E12). Decorative: the tool's name always sits beside it. */
export function ToolMark({ id, name, className }: { id: string; name: string; className?: string }) {
  const logo = TOOL_LOGOS[id]
  return (
    <span className={cn('tool-mark', !logo && 'is-letters', className)} aria-hidden="true">
      {logo ? <img src={logo} alt="" width={64} height={64} /> : nameLetters(name)}
    </span>
  )
}

/** The look of a setup button: the screen's one navy button, an outlined one, or quiet text. */
type SetupButtonLook = 'primary' | 'outline' | 'text'
const SETUP_BUTTON_CLASS: Record<SetupButtonLook, string> = { primary: 'primary', outline: 'secondary', text: 'text-action' }

/**
 * The shared Button (its touch size, cursors, aria-disabled and busy behaviour) in the setup palette: `bare` drops
 * My Work's own look and setup.css draws the navy, outlined or text one.
 */
export function SetupButton({ look = 'primary', className, type = 'button', ...props }: ComponentProps<typeof Button> & { look?: SetupButtonLook }) {
  return <Button type={type} variant="bare" className={cn(SETUP_BUTTON_CLASS[look], className)} {...props} />
}

/** The one line a screen shows beside a dimmed button, saying what it waits for (D6). Dimmed buttons point at it. */
export const SETUP_WAITING_LINE_ID = 'setup-waiting-line'

/**
 * Why a dimmed Back waits. Both stay true for as long as Back is dimmed: the scan moves on by itself when it finishes
 * and Back turns on if it stops, and the import screen shows only while the import runs.
 */
const BACK_WAIT_WORDS: Record<SetupBackWait, string> = {
  scan: 'Back waits while the scan runs.',
  import: 'Back waits while the import runs.',
}

/** Back on a screen: where it goes, and what it waits for while it is dimmed. */
export interface SetupBack { onBack: () => void; waitsFor: SetupBackWait | null }

/**
 * Every screen's bottom row (plan Phase 8): Back on the left, always in the same slate style; on the right the line
 * saying what a dimmed button waits for, an optional outlined button, and the screen's one navy button.
 */
export function SetupActions({ back, start, waiting, className, children }: {
  back?: SetupBack | null
  /** What the first screen, which has no Back, keeps on the row's left (the install's reinstall choice). */
  start?: ReactNode
  waiting?: ReactNode; className?: string; children?: ReactNode
}) {
  const { t } = useI18n()
  const line = waiting ?? (back?.waitsFor ? t(BACK_WAIT_WORDS[back.waitsFor]) : null)
  return (
    <div className={cn('setup-actions', className)}>
      {start && <div className="setup-actions-start">{start}</div>}
      {back && (
        <SetupButton look="text" className="setup-back" onClick={back.onBack}
          aria-disabled={back.waitsFor ? true : undefined} aria-describedby={back.waitsFor && line ? SETUP_WAITING_LINE_ID : undefined}>
          <ArrowLeftIcon aria-hidden="true" />{t('Back')}
        </SetupButton>
      )}
      <div className="setup-actions-forward">
        {line && <p id={SETUP_WAITING_LINE_ID} className="setup-waiting">{line}</p>}
        {children}
      </div>
    </div>
  )
}

/**
 * The second line of a failed request: what to check, by what went wrong (plan G17). The worker refuses a setup
 * request when setup is not where this page thinks it is (409: the installer applied a choice, setup finished, the
 * scan is past that question) or a part of it is not ready yet (503), so the check is a reload, which reads where
 * setup is now. The worker's own reason stays under Details.
 */
const FAILURE_CHECK: Record<SetupFailureKind, string> = {
  unreachable: 'Can’t reach claude-mem on this computer. It may be restarting. Wait a moment, then try again.',
  refused: 'claude-mem is running but turned this down. This page may be out of date: reload it, then try again.',
  page: 'This page ran into a problem. Reload it, then try again.',
}

/**
 * A failure in plain words (plan G17): what failed, what to check, then the raw cause folded under Details in
 * monospace, then a way on when the failure has one of its own. An alert, because it stops what the person was doing.
 * A failed request passes `failure`: its kind words the check (unless the screen gives its own) and its raw words fill Details.
 */
export function SetupError({ title, check, failure, detail = failure?.detail, action, className }: {
  title: ReactNode; check?: ReactNode; failure?: SetupFailure | null; detail?: string | null; action?: ReactNode; className?: string
}) {
  const { t } = useI18n()
  return (
    <Alert variant="destructive" role="alert" className={cn('setup-error', className)}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{check ?? (failure && t(FAILURE_CHECK[failure.kind]))}</p>
        {detail && (
          <Collapsible className="setup-error-details">
            <CollapsibleFoldTrigger>{t('Details')}</CollapsibleFoldTrigger>
            {/* forceMount: the raw words stay in the document while folded (hidden), as a closed <details> kept them. */}
            <CollapsibleContent forceMount className="setup-error-detail"><pre>{detail}</pre></CollapsibleContent>
          </Collapsible>
        )}
      </AlertDescription>
      {action && <AlertAction>{action}</AlertAction>}
    </Alert>
  )
}

/**
 * The line under a text box whose text was cut to its cap (format.ts `capText`, setup-search.ts `keptNoteText`): what
 * was kept, so nothing is cut silently. `max` is how many characters were kept: the box's cap when it counts characters,
 * or the kept text's length when the cap is in bytes.
 */
export function CutNotice({ id, max }: { id: string; max: number }) {
  const { t } = useI18n()
  return <p id={id} className="setup-hint" role="status"><InfoIcon aria-hidden="true" />{interpolate(t('Only the first {count} characters are kept.'), { count: max.toLocaleString('en-US') })}</p>
}
