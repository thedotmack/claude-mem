// The page around every My Work screen (design pass Phase 3): the skip link, the one bar, the page column with its
// h1, and the phone's bottom bar. The loaded app and the two screens before it (the first read still open, the first
// read failed) draw the same frame, so the bar works on all three: the places and Memory stay one press away while
// the work cannot be read (Codex D14, Claude D22). The screens take the theme from <html>, which index.html sets before
// the first paint (G8), so a dark user never sees them light.
import { useEffect, useRef, type ReactNode, type Ref } from 'react'
import { CircleAlertIcon, LibraryIcon, RefreshCwIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { isServedFromCloud } from '@/live/served-from'
import { MEMORY_PLACE } from '../../../app-places'
import { AppBottomBar, AppTopBar, usePageHeadingBeforeLoad } from './app-bar'
import { TechnicalDetails } from './error-details'

/**
 * `above`: what sits over the bar (the cloud trial banner, an offer, the sample strip). `heading`: the page's h1, shown
 * unless `headingHidden` (a focus area's page names its area in its own header); `aboveHeading` and `belowHeading` sit
 * right over and under it (a page's crumb, the failure line). `compact`: the page sits in Codex's narrower column
 * (Find work, Workspace, Machine and sync). `below`: what floats over the page (the request drawer).
 * `data-slot="work-shell"` turns on the scroll padding in index.css that keeps a focused control clear of the bar and
 * the phone's bottom bar.
 */
export function ShellFrame({ above, heading, headingHidden = false, aboveHeading, belowHeading, compact = false, mainRef, below, children }: {
  above?: ReactNode; heading: string; headingHidden?: boolean; aboveHeading?: ReactNode; belowHeading?: ReactNode; compact?: boolean
  mainRef?: Ref<HTMLElement>; below?: ReactNode; children: ReactNode
}) {
  const { t } = useI18n()
  return (
    <div data-slot="work-shell" className="min-h-svh pb-[calc(var(--spacing-bottom-bar)+var(--spacing-bottom-bar-gap)+env(safe-area-inset-bottom))] text-foreground md:pb-0">
      {/* The first Tab stop (F skip-links), as in setup (setup-page.tsx). */}
      <a href="#main-content" className="sr-only rounded-lg border border-control-edge bg-card px-4 py-2.5 text-sm font-medium text-foreground shadow-popover outline-none focus:not-sr-only focus:fixed focus:top-3 focus:left-4 focus:z-[200] focus-visible:ring-3 focus-visible:ring-ring/50">
        {t('Skip to content')}
      </a>
      {above}
      <AppTopBar />
      <div className={cn('mx-auto w-full px-4 pt-6 md:px-14 md:pt-12 md:pb-16', compact ? 'max-w-compact' : 'max-w-page')}>
        <main ref={mainRef} id="main-content" tabIndex={-1} className="min-w-0 space-y-4 outline-none md:space-y-5">
          {aboveHeading}
          <h1 className={cn('text-page-title-phone md:text-page-title', headingHidden && 'sr-only')}>{heading}</h1>
          {belowHeading}
          {children}
        </main>
      </div>
      <AppBottomBar />
      {below}
    </div>
  )
}

/** A panel of the loading screen: a card holding still placeholder lines (the ring beside the words is what moves). */
function PlaceholderPanel({ className, lines }: { className?: string; lines: string[] }) {
  return (
    <div className={cn('space-y-3 rounded-xl border bg-card p-6 md:p-7', className)}>
      {lines.map((line, index) => <Skeleton key={index} className={cn('h-4 motion-safe:animate-none', line)} />)}
    </div>
  )
}

/**
 * While the first read is open (Codex D14, mockup `loading`): the bar, the page's h1, one status line read out once
 * (D b18 M 372), and the home page's content area kept for it: the lead card and its neighbour, then a row of focus
 * areas. Nothing shaped like navigation: the bar above is the real one. No timer: the read ends in the work or in the
 * failed screen below.
 */
export function ShellLoading() {
  const { t } = useI18n()
  const heading = usePageHeadingBeforeLoad()
  return (
    <ShellFrame heading={heading}>
      <div aria-busy="true" className="space-y-5 md:space-y-8">
        <p role="status" className="flex items-center gap-2.5 text-muted-foreground">
          <Spinner className="size-4.5" />{t('Reading local work…')}
        </p>
        <div aria-hidden="true" className="grid gap-3 md:grid-cols-3 md:gap-8">
          <PlaceholderPanel className="md:col-span-2" lines={['w-2/5', 'h-9 w-3/5', 'w-4/5', 'w-2/5']} />
          <PlaceholderPanel lines={['w-2/5', 'w-4/5']} />
        </div>
        <div aria-hidden="true" className="space-y-3">
          <Skeleton className="h-4 w-2/5 motion-safe:animate-none" />
          <div className="grid gap-3 md:grid-cols-3 md:gap-4">
            {Array.from({ length: 3 }, (_, card) => <PlaceholderPanel key={card} lines={['w-2/5', 'w-4/5']} />)}
          </div>
        </div>
      </div>
    </ShellFrame>
  )
}

/**
 * The first read failed (Codex D14, mockup `unavailable`; G17): what did not answer in one plain sentence, then "Try
 * again" (the screen's one primary, G1) and Memory, which the same worker serves as its own page, on this computer and
 * behind the cloud viewer's gate alike (services/viewer-host/src/gate.ts); the raw cause folds under Technical details.
 * Announced as an alert. No automatic retry: the person decides. `focusRetry`: this screen came back after the person
 * pressed Try again, so focus goes back to that button instead of staying on the page body.
 */
export function ShellReadError({ cause, onRetry, focusRetry = false }: { cause: string; onRetry: () => void; focusRetry?: boolean }) {
  const { t } = useI18n()
  const heading = usePageHeadingBeforeLoad()
  const cloud = isServedFromCloud(window.location.hostname)
  const retryRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (focusRetry) retryRef.current?.focus() }, [focusRetry])
  return (
    <ShellFrame heading={heading}>
      <section role="alert" className="max-w-2xl space-y-3 rounded-xl border bg-card p-4.5 shadow-panel md:p-8">
        <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground"><CircleAlertIcon aria-hidden="true" className="size-5" /></span>
        <h2 className="text-2xl font-semibold tracking-tight">{t('Local work couldn’t load')}</h2>
        <p className="text-muted-foreground">
          {cloud ? t('Your cloud viewer didn’t answer. Try again in a moment.') : t('The worker on this computer didn’t answer. It may be restarting.')}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button ref={retryRef} onClick={onRetry}><RefreshCwIcon aria-hidden="true" />{t('Try again')}</Button>
          <Button asChild variant="outline"><a href={MEMORY_PLACE.address}><LibraryIcon aria-hidden="true" />{t('Open Memory')}</a></Button>
        </div>
        <TechnicalDetails cause={cause} />
      </section>
    </ShellFrame>
  )
}
