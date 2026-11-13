import { useEffect, useState } from 'react'
import { CheckIcon, MessageSquareIcon, TerminalIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import type { Request } from '@/data'
import { chatLinks, requestChat } from '@/live/chat-links'
import { useWorkModel } from '@/store'
import { ProductLink } from './bits'

type CopyState = 'idle' | 'copied' | 'failed'
const COPY_SHOWN_FOR_MS = 2000
const CONTROL = 'h-11 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground md:h-7'

/** Copies the command that reopens the session in its tool, and says so. */
function CopyResumeCommand({ command }: { command: string }) {
  const { t } = useI18n()
  const [state, setState] = useState<CopyState>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const reset = setTimeout(() => setState('idle'), COPY_SHOWN_FOR_MS)
    return () => clearTimeout(reset)
  }, [state])
  const copy = () => navigator.clipboard.writeText(command).then(() => setState('copied'), () => setState('failed'))
  const label = interpolate(t('Copy the command that resumes this chat: {command}'), { command })
  return (
    <Button variant="ghost" size="sm" className={cn(CONTROL, 'min-w-11 md:min-w-7')} onClick={copy} aria-label={label} title={label}>
      {state === 'copied' ? <CheckIcon /> : <TerminalIcon />}
      <span role="status">{state === 'copied' ? t('Copied') : state === 'failed' ? t('Couldn’t copy') : ''}</span>
    </Button>
  )
}

/**
 * The request's chat, one click away: a link its tool's desktop app handles, and beside it the terminal command to
 * copy, since neither link is documented. Nothing renders for a request with no chat a link can be built for.
 * A sample session exists nowhere, so its link says so and opens nothing (as ProductLink does).
 */
export function ChatLink({ request, className }: { request: Pick<Request, 'id' | 'chat'>; className?: string }) {
  const { t } = useI18n()
  const { sourceKind } = useWorkModel()
  const links = chatLinks(requestChat(request))
  if (!links) return null
  const link = cn(buttonVariants({ variant: 'ghost', size: 'sm' }), CONTROL)
  const label = <><MessageSquareIcon />{interpolate(t('Open in {tool}'), { tool: links.tool })}</>
  return (
    <Req ids={['R19.1']}>
      <span className={cn('flex flex-wrap items-center', className)}>
        {sourceKind === 'sample' ? <ProductLink href="#" className={link}>{label}</ProductLink> : <a href={links.openHref} className={link}>{label}</a>}
        <CopyResumeCommand command={links.resumeCommand} />
      </span>
    </Req>
  )
}
