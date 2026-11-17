import type { ReactNode } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { interpolate, useI18n } from '@/lib/i18n'

/**
 * The quotes after the first, under the one fold row (G5: chevron, the label with its count, the Button focus ring and
 * 44px at every width). The fold opens below its row. My Rules' current rule and Suggested areas' cards share it.
 */
export function MoreQuotesFold({ count, children }: { count: number; children: ReactNode }) {
  const { t } = useI18n()
  return (
    <Collapsible data-slot="more-quotes">
      <CollapsibleFoldTrigger className="text-xs font-normal text-muted-foreground">
        <span className="group-data-[state=open]/fold-trigger:hidden">{interpolate(count === 1 ? t('{count} more quote') : t('{count} more quotes'), { count })}</span>
        <span className="hidden group-data-[state=open]/fold-trigger:inline">{t('Fewer quotes')}</span>
      </CollapsibleFoldTrigger>
      <CollapsibleContent className="space-y-2 pt-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}
