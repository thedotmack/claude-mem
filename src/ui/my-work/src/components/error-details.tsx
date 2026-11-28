import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useI18n } from '@/lib/i18n'

/**
 * The raw cause of a failure, folded under "Details" in monospace (G17): the screen says what happened in plain words
 * first, then offers Try again; the worker's own message is here for a person who wants it. The shell's read-failure
 * screen draws the same fold (app-shell.tsx).
 */
export function ErrorDetails({ cause }: { cause: string }) {
  const { t } = useI18n()
  return (
    <Collapsible>
      <CollapsibleFoldTrigger className="text-xs">{t('Details')}</CollapsibleFoldTrigger>
      <CollapsibleContent>
        <p className="mt-2 rounded-md bg-muted px-3 py-2 font-mono text-xs break-words text-foreground/80">{cause}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * A failure's raw cause behind "Technical details", a quiet text button (Codex's `textbtn`): the details are for
 * whoever has to fix it, not the next step. The failed first read (app-shell.tsx) and a failed review on Machine and
 * sync (pages/machine-sync.tsx) fold their cause this way.
 */
export function TechnicalDetails({ cause }: { cause: string }) {
  const { t } = useI18n()
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-2 text-accent-foreground">{t('Technical details')}</Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-2 rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-foreground/80">{cause}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}
