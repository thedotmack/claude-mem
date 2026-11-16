// The shell's own pieces that show before the work model has loaded (page-06): the brand the header always keeps, the
// skeleton of the real layout while the first read is open, and the failed read. Both screens take the theme from
// <html>, which index.html sets before the first paint (G8), so a dark user never sees them light.
import { useEffect, useRef, type ReactNode } from 'react'
import { useI18n } from '@/lib/i18n'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { isServedFromCloud } from '@/live/served-from'
import { CLASSIC_VIEWER_PATH } from './bits'
import { CmemMark } from './brand'

/** The logo and the name, as the header shows them at every width and in every state (page-06 F navigation-consistency). */
export function AppBrand() {
  return (
    <span className="flex shrink-0 items-center gap-2">
      <CmemMark className="size-8 text-[#D86441]" />
      <span className="sr-only md:not-sr-only md:text-[0.95rem] md:font-semibold md:tracking-tight">claude-mem</span>
    </span>
  )
}

/** The bar the loaded app draws at the top of the page, with only what is known before any work has been read. */
function ShellHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-card/95">
      <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 md:px-6">
        <AppBrand />
      </div>
    </header>
  )
}

/**
 * The page under the header: the rail column (from 768px; icons only up to 1023px) and the main column. The loaded app
 * (App.tsx) and the screens below draw the same grid, so the page keeps its shape from the first paint.
 */
export function ShellGrid({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1440px] gap-6 px-4 py-4 md:grid md:grid-cols-[52px_minmax(0,1fr)] md:px-6 md:py-6 lg:grid-cols-[184px_minmax(0,1fr)] lg:gap-8">
      {children}
    </div>
  )
}

/** The rail's place, still empty, and the main column. */
function ShellColumns({ children }: { children: ReactNode }) {
  return (
    <ShellGrid>
      <div aria-hidden="true" className="hidden space-y-2.5 md:block">
        {/* Still, not pulsing: the ring beside the words is the one thing that moves (plan rule 8). */}
        {Array.from({ length: 5 }, (_, row) => <Skeleton key={row} className="h-7 rounded-[10px] motion-safe:animate-none" />)}
      </div>
      <main id="main-content" tabIndex={-1} className="min-w-0 outline-none">{children}</main>
    </ShellGrid>
  )
}

/**
 * While the first read is open: the header, then the shape of the page (a title, two cards, rows) around one status
 * line, read out once (D b18 M 372). No timer: the read ends in the work or in the failed screen below.
 */
export function ShellLoading() {
  const { t } = useI18n()
  return (
    <div className="min-h-svh text-foreground">
      <ShellHeader />
      <ShellColumns>
        <div aria-busy="true" className="space-y-4">
          <Skeleton className="h-7 w-1/2 max-w-sm motion-safe:animate-none" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-36 rounded-xl motion-safe:animate-none" />
            <Skeleton className="h-36 rounded-xl motion-safe:animate-none" />
          </div>
          <p className="flex justify-center py-1 text-sm text-muted-foreground">
            <Spinner label={t('Reading local work…')} />
          </p>
          {Array.from({ length: 3 }, (_, row) => <Skeleton key={row} className="h-12 rounded-xl motion-safe:animate-none" />)}
        </div>
      </ShellColumns>
    </div>
  )
}

/**
 * The first read failed (page-06, G17): what happened in plain words, saying the worker may be restarting; the raw
 * cause folded under Details in monospace; then "Try again" (the screen's one primary, G1) and the classic viewer,
 * which the same worker serves as a simpler page, on this computer and behind the cloud viewer's gate alike
 * (services/viewer-host/src/gate.ts), as the loaded header offers it. Announced as an alert. No automatic retry: the
 * person decides. `focusRetry`: this screen came back after the person pressed Try again, so focus goes back to that
 * button instead of staying on the page body (the loading screen in between had nothing to focus).
 */
export function ShellReadError({ cause, onRetry, focusRetry = false }: { cause: string; onRetry: () => void; focusRetry?: boolean }) {
  const { t } = useI18n()
  const cloud = isServedFromCloud(window.location.hostname)
  const retryRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (focusRetry) retryRef.current?.focus() }, [focusRetry])
  return (
    <div className="min-h-svh text-foreground">
      <ShellHeader />
      <ShellColumns>
        <Alert variant="attention" role="alert" className="max-w-xl px-5 py-4">
          <AlertTitle><h2 className="text-base font-semibold">{t("Can't read local work right now")}</h2></AlertTitle>
          <AlertDescription className="text-foreground/80">
            {cloud ? t('My Work did not get an answer from your cloud viewer. Try again in a moment.')
              : t('My Work did not get an answer from the claude-mem worker on this computer. It may be restarting.')}
          </AlertDescription>
          {/* Beside the description in the alert's text column, so the alert's own link underline stays off the buttons. */}
          <div className="col-start-2 space-y-3 pt-2.5">
            <Collapsible>
              <CollapsibleFoldTrigger className="text-xs">{t('Details')}</CollapsibleFoldTrigger>
              <CollapsibleContent>
                <p className="mt-2 rounded-md bg-card px-3 py-2 font-mono text-xs break-words text-foreground/80">{cause}</p>
              </CollapsibleContent>
            </Collapsible>
            <div className="flex flex-wrap gap-2">
              <Button ref={retryRef} onClick={onRetry}>{t('Try again')}</Button>
              <Button asChild variant="outline"><a href={CLASSIC_VIEWER_PATH}>{t('Open classic viewer')}</a></Button>
            </div>
          </div>
        </Alert>
      </ShellColumns>
    </div>
  )
}
