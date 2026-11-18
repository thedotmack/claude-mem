import { useState } from 'react'
import { CheckIcon, CopyIcon, ExternalLinkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { interpolate, useI18n } from '@/lib/i18n'
import { PRODUCT_ICON } from '@/lib/product-icons'
import { DELIVERABLE_GROUP, deliverableName, deliverablesInOpeningOrder, type DeliverableGroup } from '@/lib/deliverables'
import { cn } from '@/lib/utils'
import { isSampleHref, type Request } from '@/data'
import { FailureDetails, ProductLink, type Translate } from './bits'

type Product = Request['workProduct'][number]

/**
 * Which deliverables the list shows: all of them, or one group (c-bits-product-link M: All, Docs and pages, Code).
 * The person is its one writer, through the filter buttons; it starts at All each time the list is drawn. While the
 * buttons are hidden the list shows All, whatever was chosen before.
 */
type DeliverableFilter = 'all' | DeliverableGroup

/** Each filter's words; each entry words its own literal text, so the catalog test sees it. */
const FILTER_WORDS: Record<DeliverableFilter, (t: Translate) => string> = {
  all: (t) => t('All'),
  'docs-and-pages': (t) => t('Docs and pages'),
  code: (t) => t('Code'),
}

/**
 * A request's deliverables, as the drawer lists them (c-bits-product-link, c-request-detail): the things a person opens
 * first, commits folded into one row with their count, and filters (All, Docs and pages, Code) with counts when the
 * list holds both groups. Each row has its kind as a word in a fixed column and its name wrapping in full. A row that
 * opens something is a link to a new tab and shows the new-tab mark; a row with nothing to open looks plain and offers
 * Copy. Nothing is dropped: every item is one click away. Self-contained, so either drawer layout can mount it (rule 12).
 */
export function DeliverableList({ products }: { products: readonly Product[] }) {
  const { t } = useI18n()
  const [filter, setFilter] = useState<DeliverableFilter>('all')
  if (products.length === 0) return <p className="text-sm text-muted-foreground">{t('Nothing attached yet.')}</p>
  const inGroup = (group: DeliverableGroup) => products.filter((product) => DELIVERABLE_GROUP[product.kind] === group)
  const counts: Record<DeliverableFilter, number> = { all: products.length, 'docs-and-pages': inGroup('docs-and-pages').length, code: inGroup('code').length }
  // A filter that would show the same list as All is no choice at all.
  const offersFilters = counts['docs-and-pages'] > 0 && counts.code > 0
  // Without the buttons there is no way back from a group: a live update that empties the chosen group (a document
  // whose file was deleted) would otherwise hide every deliverable left.
  const shown: DeliverableFilter = offersFilters ? filter : 'all'
  const ordered = deliverablesInOpeningOrder(shown === 'all' ? products : inGroup(shown))
  const rows = ordered.filter((product) => product.kind !== 'Commit')
  const commits = ordered.filter((product) => product.kind === 'Commit')
  return (
    <div data-slot="deliverable-list" className="space-y-2">
      {offersFilters && (
        <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={shown} onValueChange={(next) => { if (next) setFilter(next as DeliverableFilter) }}
          aria-label={t('Which deliverables to show')} className="flex-wrap">
          {(Object.keys(FILTER_WORDS) as DeliverableFilter[]).map((key) => (
            <ToggleGroupItem key={key} value={key} className="gap-1.5 px-3">
              {FILTER_WORDS[key](t)}
              <span className="mono-number text-muted-foreground group-data-[state=on]/toggle:text-foreground">{counts[key]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      <ul className="-mx-3 divide-y divide-border/70">
        {rows.map((product, index) => <li key={`${index}-${product.kind}-${product.label}`}><DeliverableRow product={product} /></li>)}
        {commits.length > 0 && (
          <li>
            <Collapsible>
              <CollapsibleFoldTrigger className="border-transparent">
                {interpolate(commits.length === 1 ? t('{count} commit') : t('{count} commits'), { count: commits.length })}
              </CollapsibleFoldTrigger>
              <CollapsibleContent>
                <ul className="divide-y divide-border/70">
                  {commits.map((product, index) => <li key={`${index}-${product.label}`}><DeliverableRow product={product} /></li>)}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          </li>
        )}
      </ul>
    </div>
  )
}

/** The row's look: 44px at the least (the review kept its 47px rows), the kind in a fixed column, the name wrapping. */
const ROW_CLASS_NAME = 'flex min-h-11 items-center gap-3 rounded-lg px-3 py-1.5 text-sm'

function DeliverableRow({ product }: { product: Product }) {
  const { t } = useI18n()
  const Icon = PRODUCT_ICON[product.kind]
  const name = deliverableName(product)
  const opens = product.href !== undefined && !isSampleHref(product.href)
  const parts = (
    <>
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      {/* The kind column is at least 4rem (68px at the 17px root), which holds every English kind word (the widest,
          "Commit", measures 53.3px in Geist at 14.9px). A longer translated word (French "Présentation" 99.8px, Korean
          "슬라이드" 91.3px, Turkish "Bağlantı" 79.4px; measured 2026-11-16) widens its own row's column instead of running
          under the name, so no kind word is ever cut or covered. */}
      <span className="min-w-16 shrink-0 text-muted-foreground">{t(product.kind)}</span>
      <span className="min-w-0 flex-1">
        <span className={cn('block [overflow-wrap:anywhere]', product.kind === 'Branch' && 'font-mono text-[0.8125rem]')}>{name}</span>
        {product.availability === 'origin-only' && <span className="block text-xs text-muted-foreground">{t('Local file — check the original computer')}</span>}
      </span>
    </>
  )
  if (product.href !== undefined) {
    return (
      <ProductLink href={product.href} className={cn(ROW_CLASS_NAME, opens && 'hover:bg-surface')}>
        {parts}
        {opens && <ExternalLinkIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
      </ProductLink>
    )
  }
  // The row wraps so a refused copy's words and Details take their own line under it (CopyName).
  return (
    <div className={cn(ROW_CLASS_NAME, 'flex-wrap')}>
      {parts}
      <CopyName name={name} />
    </div>
  )
}

/**
 * What Copy beside a name with nothing to open shows, as people see and hear it. Its one writer is CopyName's press:
 *
 *   ready ──the copy works──▶ copied ──press──▶ copied or refused
 *   ready ──the browser refuses──▶ refused ──press──▶ copied or refused
 */
type CopyNameState = 'ready' | 'copied' | 'refused'

/**
 * Each state's mark on the button and its words: what a screen reader hears once the copy worked (`spoken`), and the
 * plain line a refusal shows (`refusal`, an alert; the browser's own words go under Details, G17). Each entry words its
 * own literal text, so the catalog test sees it.
 */
const COPY_NAME_LOOK: Record<CopyNameState, { Mark: typeof CopyIcon; spoken: ((t: Translate) => string) | null; refusal: ((t: Translate) => string) | null }> = {
  ready: { Mark: CopyIcon, spoken: null, refusal: null },
  copied: { Mark: CheckIcon, spoken: (t) => t('Copied'), refusal: null },
  refused: { Mark: CopyIcon, spoken: null, refusal: (t) => t('Could not copy. Select the name to copy it.') },
}

/**
 * Copy for a row with nothing to open (c-bits-product-link M): a branch name or a local commit is used by pasting it.
 * After a copy the mark is a check until the name is copied again; a refused copy says so in plain words, with the
 * browser's reason under Details, and the name stays on screen to select by hand.
 */
function CopyName({ name }: { name: string }) {
  const { t } = useI18n()
  const [copy, setCopy] = useState<{ state: CopyNameState; cause: string | null }>({ state: 'ready', cause: null })
  const copyName = async () => {
    try {
      await navigator.clipboard.writeText(name)
      setCopy({ state: 'copied', cause: null })
    } catch (error) {
      // The browser refused the clipboard (no permission, or an insecure page): the line says what to do instead.
      setCopy({ state: 'refused', cause: error instanceof Error ? error.message : String(error) })
    }
  }
  const { Mark, spoken, refusal } = COPY_NAME_LOOK[copy.state]
  return (
    <>
      <Button variant="ghost" size="icon-sm" className="shrink-0" onClick={copyName} aria-label={interpolate(t('Copy “{name}”'), { name })}>
        <Mark aria-hidden="true" />
      </Button>
      <span role="status" className="sr-only">{spoken?.(t) ?? ''}</span>
      {refusal && (
        <div className="basis-full pb-1 text-xs text-muted-foreground">
          <p role="alert">{refusal(t)}</p>
          <FailureDetails cause={copy.cause} />
        </div>
      )}
    </>
  )
}
