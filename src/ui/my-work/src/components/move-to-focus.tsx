// Move to focus: files one request under another focus or Other, as the owner's placement (a refresh never overrides
// it). One control for the thread rows and the request page; both save the same owner change, shown with Undo.
import { FolderInputIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import type { Request } from '@/data'
import { useWorkModel } from '@/store'
import { moveChoices } from '@/live/thread-groups'
import { useFocusChanges } from './focus-changes'

/**
 * `row` is the icon button at the end of a thread's row; `page` the worded button on the request page. Nothing is
 * rendered when the request cannot be moved anywhere.
 */
export function MoveToFocus({ request, variant, className }: { request: Request; variant: 'row' | 'page'; className?: string }) {
  const { t } = useI18n()
  const { focusAreas } = useWorkModel()
  // The shared save: a second pick while one move is saving does nothing.
  const changes = useFocusChanges()
  const choices = moveChoices(request, focusAreas)
  if (choices.length === 0) return null
  const title = request.title ?? request.resolvesTo?.title ?? t('New request, title being written')
  const move = (focusAreaId: string) => { if (!choices.find((choice) => choice.id === focusAreaId)?.current) void changes.apply({ action: 'move-request', requestId: request.id, focusAreaId }) }
  return (
    <Req ids={['R16.6']}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {variant === 'row'
            ? <Button variant="ghost" size="sm" disabled={changes.saving} title={t('Move to focus')} aria-label={interpolate(t('Move “{title}” to another focus'), { title })} className={cn('size-11 shrink-0 p-0 text-muted-foreground data-[state=open]:opacity-100 md:size-7', className)}><FolderInputIcon /></Button>
            : <Button variant="outline" size="sm" disabled={changes.saving} aria-label={t('Move to another focus area')} className={cn('h-11 text-xs md:h-8', className)}><FolderInputIcon />{changes.saving ? t('Moving…') : t('Move to…')}</Button>}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" collisionPadding={8} className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] max-w-80 min-w-64 overflow-y-auto">
          <DropdownMenuLabel>{t('Move to focus')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={choices.find((choice) => choice.current)?.id ?? ''} onValueChange={move}>
            {choices.map((choice) => (
              <DropdownMenuRadioItem key={choice.id} value={choice.id}>
                <span className="min-w-0 truncate">{choice.name ?? t('Other')}</span>
                {choice.suggested && <span className="text-xs text-muted-foreground">{t('suggested')}</span>}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </Req>
  )
}
