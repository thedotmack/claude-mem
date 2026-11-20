import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
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
