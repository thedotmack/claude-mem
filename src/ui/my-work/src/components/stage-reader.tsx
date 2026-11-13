// The stage reader: a ready stage shown as a document inside the page, so a brief is read where the review is made.
// Markdown is laid out by the page from a parsed tree (live/stage-markdown.ts), never injected as HTML; an HTML
// stage (a deck) runs in a sandboxed frame that shares nothing with the page.
import { useEffect, useState, type ReactNode } from 'react'
import { CheckIcon, ExternalLinkIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { SaveButton } from '@/components/save-button'
import { buttonVariants } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import type { Request } from '@/data'
import { useStore, useWorkModel } from '@/store'
import { withLocalApiTokenQuery } from '../../../local-api-token-client'
import { parseMarkdown, type Block, type Inline } from '@/live/stage-markdown'
import { STAGE_FRAME_SANDBOX, stageFrameDocument } from '@/live/stage-frame'
import { readerCheck, stageReading, type ReaderCheck, type StageRead, type StageReading } from '@/live/stage-reader'
import { threadAction } from '@/live/thread-groups'
import { ChatLinks, useRequestChatLinks } from './thread-list'
import { CHANGED_WHILE_READING_MESSAGE } from '@/live/review-response'
import { useCheckSave } from './use-request-saves'

const LINK = 'underline decoration-border underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-ring'

function Inlines({ inlines }: { inlines: Inline[] }): ReactNode {
  return inlines.map((inline, index) => {
    switch (inline.kind) {
      case 'text': return inline.text
      case 'code': return <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{inline.text}</code>
      case 'strong': return <strong key={index} className="font-semibold"><Inlines inlines={inline.children} /></strong>
      case 'em': return <em key={index}><Inlines inlines={inline.children} /></em>
      case 'link': return <a key={index} href={inline.href} target="_blank" rel="noreferrer" className={LINK}><Inlines inlines={inline.children} /></a>
      case 'image': return <img key={index} src={withLocalApiTokenQuery(inline.src)} alt={inline.alt} loading="lazy" className="my-2 block h-auto max-w-full rounded-md border" />
    }
  })
}

const HEADING = { 1: 'text-xl font-semibold tracking-tight', 2: 'text-lg font-semibold tracking-tight', 3: 'text-base font-semibold', 4: 'text-sm font-semibold', 5: 'text-sm font-semibold', 6: 'text-sm font-semibold text-muted-foreground' } as const

function Blocks({ blocks }: { blocks: Block[] }): ReactNode {
  return blocks.map((block, index) => {
    switch (block.kind) {
      case 'heading': { const Tag = `h${block.level}` as 'h1'; return <Tag key={index} className={cn('mt-5 first:mt-0', HEADING[block.level])}><Inlines inlines={block.children} /></Tag> }
      case 'paragraph': return <p key={index} className="leading-relaxed whitespace-pre-line"><Inlines inlines={block.children} /></p>
      case 'code': return <pre key={index} className="overflow-x-auto rounded-md border bg-muted/60 p-3 font-mono text-xs leading-relaxed"><code>{block.text}</code></pre>
      case 'quote': return <blockquote key={index} className="space-y-3 border-l-2 pl-4 text-foreground/85"><Blocks blocks={block.children} /></blockquote>
      case 'rule': return <hr key={index} />
      case 'list': {
        const items = block.items.map((item, at) => <li key={at} className="space-y-2 pl-1"><Blocks blocks={item} /></li>)
        return block.ordered ? <ol key={index} start={block.start} className="list-decimal space-y-1 pl-6">{items}</ol> : <ul key={index} className="list-disc space-y-1 pl-6">{items}</ul>
      }
      case 'table': return (
        // A wide table scrolls inside the document, not the dialog.
        <div key={index} className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead><tr>{block.head.map((cell, at) => <th key={at} scope="col" className="border-b px-2 py-1.5 font-semibold"><Inlines inlines={cell} /></th>)}</tr></thead>
            <tbody>{block.rows.map((row, at) => <tr key={at}>{row.map((cell, column) => <td key={column} className="border-b px-2 py-1.5 align-top"><Inlines inlines={cell} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      )
    }
  })
}

/** Agent-written Markdown, laid out as a document. */
export function MarkdownDocument({ source }: { source: string }) {
  return <div className="space-y-3 text-sm break-words"><Blocks blocks={parseMarkdown(source)} /></div>
}

/** `read` is the request as it was when the document was opened: the only version a check from here is for. */
type Loaded = { state: 'loading' } | { state: 'ready'; reading: StageReading; text: string; read: StageRead } | { state: 'failed' }

/** The stage's file, read with a plain GET. The row may know only that a stage is ready, so the request's detail is read first for its address. */
function useStageDocument(request: Request, formatId: string | null): Loaded {
  const { stageFormats = [] } = useWorkModel()
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  useEffect(() => {
    if (formatId === null) return
    let current = true
    setLoaded({ state: 'loading' })
    void (async () => {
      try {
        const detail = request.stages ? request : await useStore.getState().loadRequestDetail(request)
        const reading = stageReading(detail.stages?.find((stage) => stage.formatId === formatId), stageFormats)
        if (!reading) throw new Error('no ready stage')
        const response = await fetch(reading.href)
        if (!response.ok) throw new Error(String(response.status))
        const text = await response.text()
        if (current) setLoaded({ state: 'ready', reading, text, read: { fingerprint: detail.contentFingerprint, reviewHash: detail.review?.hash, outdated: reading.outdated } })
      } catch {
        if (current) setLoaded({ state: 'failed' })
      }
    })()
    return () => { current = false }
    // One read per opening: a model that arrives while the reader is open does not blank the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id, formatId])
  return loaded
}

/** Why the reader does not offer the check, said where the button would be. */
const NO_CHECK: Record<Exclude<ReaderCheck, 'none' | 'offer'>, string> = {
  outdated: 'This stage was written before the latest work. Generate it again to check from here.',
  changed: CHANGED_WHILE_READING_MESSAGE,
}

/** The reader's own row of actions: the raw file, the chat, and the review the owner came to make. */
function ReaderActions({ request, reading, read, onChecked }: { request: Request; reading: StageReading | null; read: StageRead | null; onChecked: () => void }) {
  const { t } = useI18n()
  const links = useRequestChatLinks(request)
  // The check is for the version the document was opened on, whatever the request has become since.
  const check = useCheckSave(request, read ?? undefined)
  const offer = readerCheck(read, { waitsForCheck: threadAction(request) === 'mark-checked', fingerprint: request.contentFingerprint })
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3">
      {reading?.newTabHref && <a href={reading.newTabHref} target="_blank" rel="noreferrer" className={cn('inline-flex min-h-11 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground md:min-h-7', LINK)}><ExternalLinkIcon className="size-3.5" />{t('Open in new tab')}</a>}
      {links && <ChatLinks chat={links} showTranscript />}
      {check.notice && <p role="status" className="text-xs text-muted-foreground">{t(check.notice.message)}</p>}
      {(offer === 'outdated' || offer === 'changed') && <p role="status" className="ml-auto text-xs text-attention-foreground">{t(NO_CHECK[offer])}</p>}
      {offer === 'offer' && (
        <SaveButton className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'ml-auto h-11 md:h-8')} disabled={check.saving} onClick={async () => { const saved = await check.save(true); if (saved) onChecked(); return saved }}><CheckIcon />{t('Mark checked')}</SaveButton>
      )}
    </div>
  )
}

/**
 * One ready stage of `request`, opened as a dialog: its title, the document scrolling inside, and the actions under
 * it. `formatId` null keeps it closed. Loading and a file that cannot be read are said in words, never a blank box.
 */
export function StageReader({ request, formatId, onClose }: { request: Request; formatId: string | null; onClose: () => void }) {
  const { t } = useI18n()
  const { stageFormats = [] } = useWorkModel()
  const loaded = useStageDocument(request, formatId)
  if (formatId === null) return null
  const label = t(stageFormats.find((format) => format.id === formatId)?.label ?? formatId)
  const title = request.title ?? request.resolvesTo?.title ?? t('Untitled request')
  return (
    <Req ids={['R19.23']}>
      <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
        <DialogContent className="flex max-h-[calc(100svh-2rem)] flex-col gap-3 p-4 sm:max-w-3xl sm:p-6">
          <DialogHeader className="pr-8">
            <DialogTitle className="text-left leading-snug">{interpolate(t('{title} · {format}'), { title, format: label })}</DialogTitle>
            <DialogDescription className="sr-only">{t('The stage your agent wrote for this review.')}</DialogDescription>
          </DialogHeader>
          {/* The document scrolls here; the title and the actions stay in place. */}
          <div className="min-h-0 flex-1 overflow-y-auto" tabIndex={0} aria-label={label}>
            {loaded.state === 'loading' && <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Spinner className="size-4" />{t('Opening the stage…')}</p>}
            {loaded.state === 'failed' && <p role="alert" className="py-6 text-sm text-attention-foreground">{t('This stage’s file could not be read.')}</p>}
            {loaded.state === 'ready' && (loaded.reading.output === 'html'
              // No allow-same-origin: the frame has an origin of its own and can read nothing of the page or the worker.
              // What it frames is a wrapper that lets the stage reach no other address (live/stage-frame.ts).
              ? <iframe title={label} sandbox={STAGE_FRAME_SANDBOX} srcDoc={stageFrameDocument(loaded.text)} className="h-[70svh] w-full rounded-md border bg-white" />
              : <MarkdownDocument source={loaded.text} />)}
          </div>
          <ReaderActions request={request} reading={loaded.state === 'ready' ? loaded.reading : null} read={loaded.state === 'ready' ? loaded.read : null} onChecked={onClose} />
        </DialogContent>
      </Dialog>
    </Req>
  )
}
