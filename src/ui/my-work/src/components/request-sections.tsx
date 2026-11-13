import { CheckIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { SaveButton } from '@/components/save-button'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isCardDeliverable } from '@/lib/deliverables'
import { PRODUCT_ICON } from '@/lib/product-icons'
import { Req } from '@/spec/req'
import type { Request } from '@/data'
import { requestById, useStore } from '@/store'
import { ProductLink } from './bits'

/** After ship (decision 4): the open Docs, Promo and Other follow-ups, each one actionable. Nothing renders when none are open. */
export function OpenFollowUps({ request, limit }: { request: Request; limit?: number }) {
  const { t } = useI18n()
  const open = request.followUps.filter((followUp) => !followUp.done)
  if (request.state !== 'shipped' || open.length === 0) return null
  const inStore = requestById(request.id) !== null
  // Finishing a follow-up moves the next step on to the next open one, so the request never names finished work.
  const finish = (text: string) => useStore.getState().updateSampleRequest(request.id, (current) => {
    const followUps = current.followUps.map((followUp) => followUp.text === text ? { ...followUp, done: true } : followUp)
    const stillOpen = followUps.find((followUp) => !followUp.done)
    return { ...current, followUps, next: stillOpen ? { who: 'human', need: 'answer', text: stillOpen.text } : { who: 'bot', text: t('Nothing left after ship') } }
  })
  return (
    <Req ids={['R5.7']}>
      <div className="space-y-1">
        <p className="section-label">{interpolate(t('Open after ship · {count}'), { count: open.length })}</p>
        <ul className="divide-y divide-border/70">
          {open.slice(0, limit).map((followUp) => (
            <li key={followUp.text} className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
              <span className="w-12 shrink-0 text-[11px] font-medium text-muted-foreground uppercase">{followUp.tag}</span>
              <span className="min-w-0 flex-1 truncate">{followUp.text}</span>
              {inStore && <SaveButton className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-11 shrink-0 text-xs md:h-7')} onClick={() => finish(followUp.text)}><CheckIcon />{t('Done')}</SaveButton>}
            </li>
          ))}
        </ul>
      </div>
    </Req>
  )
}

/** Three chips fill one row at phone width, so any more open the drawer's full list. */
const CARD_DELIVERABLES = 3

/**
 * Deliverables as chips (R5.12): a deck, a report, a page, a PR, each one click away. Bucket copies claude-mem kept
 * are marked as deliverables by the mapper; the drawer keeps the full list with commits and branches.
 */
export function Deliverables({ request, onOpen }: { request: Request; onOpen: () => void }) {
  const { t } = useI18n()
  const products = request.workProduct.filter(isCardDeliverable)
  const count = request.detailLoaded === false ? request.detailCounts?.workProduct ?? products.length : products.length
  if (count === 0) return null
  const shown = products.slice(0, CARD_DELIVERABLES)
  const hidden = Math.max(0, count - shown.length)
  return (
    <Req ids={['R5.12', 'R5.10']}>
      <div className="space-y-1">
        <p className="section-label">{interpolate(t('Deliverables · {count}'), { count })}</p>
        <ul className="flex flex-wrap gap-1.5">
          {shown.map((product, index) => {
            const Icon = PRODUCT_ICON[product.kind]
            return (
              <li key={`${index}-${product.label}`} className="min-w-0 max-w-full">
                <ProductLink href={product.href} className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs hover:bg-surface">
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{product.label}</span>
                </ProductLink>
              </li>
            )
          })}
          {hidden > 0 && (
            <li>
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onOpen} aria-label={interpolate(t('Open the request to see {count} more deliverables'), { count: hidden })}>{interpolate(t('+{count} more'), { count: hidden })}</Button>
            </li>
          )}
        </ul>
      </div>
    </Req>
  )
}
