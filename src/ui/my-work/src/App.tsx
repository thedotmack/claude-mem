import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { MotionConfig } from 'motion/react'
import { UsersIcon } from 'lucide-react'
import { interpolate, LOCALES, LOCALE_NAMES, useI18n, type Locale } from '@/lib/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ClassicViewerLink, DeviceFreshness, FeedbackLink, GitHubStars, LiveIndicator } from '@/components/bits'
import { Navbar, NavBody } from '@/components/aceternity/resizable-navbar'
import { StickyBanner } from '@/components/aceternity/sticky-banner'
import { CmemMark } from '@/components/brand'
import { cn } from '@/lib/utils'
import { MyWork } from '@/pages/my-work'
import { ThreadSearch, ThreadSearchButton, useThreadSearch } from '@/components/thread-search'
import { Req } from '@/spec/req'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { OTHER_FOCUS_AREA_ID } from '@/data'
import { ACTIVE_SOURCE, useStore, useWorkModel, useWorkspace } from '@/store'
import type { Section } from '@/store/store-types'
import { shownFocusAreaId } from '@/store/slices/view-slice'
import { useFocusSharesLoader } from '@/live/focus-shares'
import { isServedFromCloud } from '@/live/served-from'
import { MediaSourceContext } from '@/components/observation-media/ObsMedia'
import { SAMPLE_MEDIA_SOURCE } from '@/components/observation-media/sample-media'
import { workerMediaSource } from '@/components/observation-media/worker-media-source'
/** Billing, cancel, card and synced devices live on cmem.ai; viewer accounts land here and have no other way there. */
const ACCOUNT_AND_BILLING_URL = 'https://cmem.ai/account'
const SECTION_LABEL: Record<Section, string> = { work: 'My Focus', rules: 'My Rules', suggested: 'Suggested', 'past-focus': 'Past focus' }

/** Wireframe-only theme switch: starts from ?theme=dark|light, else the system preference. */
function useDarkMode() {
  const dark = useStore((state) => state.view.dark)
  useEffect(() => { document.documentElement.classList.toggle('dark', dark) }, [dark])
  return dark
}

const HEADER_LINK = 'inline-flex h-11 shrink-0 items-center rounded-sm text-sm whitespace-nowrap text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring aria-[current=page]:font-medium aria-[current=page]:text-foreground md:h-8'

/** In the header where it has room; on narrower screens, one line above the page that scrolls sideways. */
const LINKS_PLACE = {
  header: { shown: 'hidden lg:flex', row: '' },
  page: { shown: 'flex lg:hidden', row: '-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0' },
} as const

/**
 * Every page, as plain text links: the focus list is home, and the rest are one click from anywhere. Suggested shows
 * while areas wait for a decision (or it is open); Account & billing only on the cloud viewer, which has an account.
 * `lead` goes first on the line: on a phone the header has no room left, so the search button sits here.
 */
function PageLinks({ section, focused, place, lead }: { section: Section; focused: boolean; place: keyof typeof LINKS_PLACE; lead?: ReactNode }) {
  const { t } = useI18n()
  const { focusAreas } = useWorkModel()
  const { goToPage, selectFocus } = useStore.getState()
  const suggested = focusAreas.filter((area) => area.status === 'suggested' && !area.mergedInto).length
  const link = (to: Section, label: string, open: () => void) => (
    <button type="button" onClick={open} aria-current={section === to && !(to === 'work' && focused) ? 'page' : undefined} className={HEADER_LINK}>{label}</button>
  )
  return (
    <Req ids={['R19.11']} className={LINKS_PLACE[place].shown}>
      <nav aria-label={t('Pages')} className={cn('items-center gap-x-4', LINKS_PLACE[place].shown, LINKS_PLACE[place].row)}>
        {lead}
        {link('work', t(SECTION_LABEL.work), () => goToPage('work'))}
        {link('rules', t(SECTION_LABEL.rules), () => goToPage('rules'))}
        {(suggested > 0 || section === 'suggested') && link('suggested', suggested > 0 ? interpolate(t('{count} suggested'), { count: suggested }) : t(SECTION_LABEL.suggested), () => selectFocus({ kind: 'suggested' }))}
        <Req ids={['R16.7']}>{link('past-focus', t(SECTION_LABEL['past-focus']), () => selectFocus({ kind: 'past-focus' }))}</Req>
        {isServedFromCloud(window.location.hostname) && <Req ids={['R18.1']}><a href={ACCOUNT_AND_BILLING_URL} className={HEADER_LINK}>{t('Account & billing')}</a></Req>}
      </nav>
    </Req>
  )
}

/** The header bar: full width at the top of the page, a floating pill once the page scrolls (`Navbar` passes `visible`). */
function HeaderBody({ visible, children }: { visible?: boolean; children: ReactNode }) {
  return (
    // Phones: the pill is 2rem narrower than the bar, so it trims its padding and gaps, and the page title gives way first.
    <NavBody visible={visible} className={cn('flex h-14 max-w-[1440px] gap-3 bg-card/95 px-4 py-0 md:px-6', visible ? 'header-pill gap-1.5 border border-border/70 px-2.5 md:gap-3 md:px-6' : 'rounded-none border-b border-border/70')}>
      {children}
    </NavBody>
  )
}

/** TeamBrain is a switch on the same GUI; turning it on is where the team plan is bought (§9). */
function TeamSwitch({ team, onChange }: { team: boolean; onChange: (team: boolean) => void }) {
  const { t } = useI18n()
  return (
    <Req ids={['R9.1', 'R9.4']}>
      <HoverCard openDelay={100}>
        <HoverCardTrigger asChild>
          <Button variant={team ? 'secondary' : 'ghost'} size="sm" className={cn('px-2 text-xs', team && 'bg-accent text-accent-foreground hover:bg-accent')} onClick={() => onChange(!team)}><UsersIcon />{t('Team')}</Button>
        </HoverCardTrigger>
        <HoverCardContent className="w-64 space-y-2 text-xs">
          <p className="font-medium">TeamBrain</p>
          <p className="text-muted-foreground">{t('See everyone’s requests on one board, with who asked and where work collides.')}</p>
          {!team && <Button size="sm" className="w-full">{t('Start team plan')}</Button>}
        </HoverCardContent>
      </HoverCard>
    </Req>
  )
}

function LanguageSelector() {
  const { t, locale, setLocale } = useI18n()
  return (
    <div className="flex items-center">
      <select
        aria-label={t('Language')}
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="h-7 rounded-md border border-border bg-card px-2 text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {LOCALES.map((code) => <option key={code} value={code}>{LOCALE_NAMES[code]}</option>)}
      </select>
    </div>
  )
}

const SetupPage = lazy(() => import('@/setup/setup-page'))
const MyRules = lazy(() => import('@/pages/my-rules').then(module => ({ default: module.MyRules })))
const SuggestedAreas = lazy(() => import('@/pages/suggested-areas').then(module => ({ default: module.SuggestedAreas })))
const PastFocus = lazy(() => import('@/pages/past-focus').then(module => ({ default: module.PastFocus })))
const RequestDetail = lazy(() => import('@/components/request-detail').then(module => ({ default: module.RequestDetail })))

/** The shell remains usable while a secondary page's code arrives. */
function PageLoading({ label }: { label: string }) {
  const { t } = useI18n()
  return <section aria-label={label} aria-busy="true" className="rounded-xl border bg-card/60 p-6">
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" />{t('Loading…')}</p>
  </section>
}

/** Opening a request responds immediately, including focus trapping and a working close control. */
function RequestDetailLoading({ title, onClose }: { title: string; onClose: () => void }) {
  const { t } = useI18n()
  return <Sheet open onOpenChange={(open) => { if (!open) onClose() }}>
    <SheetContent className="w-full gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
      <SheetHeader className="gap-3 border-b p-5 md:p-6">
        <SheetTitle className="pr-8 text-xl leading-snug">{title}</SheetTitle>
        <SheetDescription>{t('Request details')}</SheetDescription>
      </SheetHeader>
      <p role="status" className="flex items-center gap-2 p-5 text-sm text-muted-foreground md:p-6"><Spinner className="size-4" />{t('Loading request detail…')}</p>
    </SheetContent>
  </Sheet>
}

export default function App() {
  // An agent may leave setup for the person's first visit. Only a persisted
  // install handoff opens it automatically; old installations and cloud readers keep My Work.
  const page = useStore((state) => state.view.page)
  const finishSetup = useStore.use.finishSetup()
  // Once per mount, read from the store at effect time. Depending on the action
  // identity re-posted an open whenever that function was replaced.
  useEffect(() => { useStore.getState().reportOpen() }, [])
  useEffect(() => {
    if (page === 'setup' || isServedFromCloud(window.location.hostname)
      || new URLSearchParams(window.location.search).get('source') === 'sample') return
    let active = true
    void import('@/setup/setup-data').then(module => module.setupPending()).then(pending => {
      if (active && pending && useStore.getState().view.page === 'app') useStore.getState().startSetup()
    }).catch(() => { /* No confirmed handoff: keep the existing workspace usable. */ })
    return () => { active = false }
  }, [page])
  if (page !== 'setup') return <WorkApp />
  return <MotionConfig reducedMotion="user"><Suspense fallback={null}><SetupPage onComplete={finishSetup} /></Suspense></MotionConfig>
}

/** Reads the active source once and follows its live feed, then renders the app. A failed load says so plainly instead of showing anything made up. */
function WorkApp() {
  const { t } = useI18n()
  const load = useStore((state) => state.work.load)
  const startWorkSource = useStore.use.startWorkSource()
  const retryWorkRead = useStore.use.retryWorkRead()
  useEffect(() => startWorkSource(ACTIVE_SOURCE), [startWorkSource])
  if (load.state === 'loaded') return <LoadedApp />
  return (
    <div className="flex min-h-svh items-center justify-center p-4 text-foreground">
      <Empty className="max-w-md border bg-card/60">
        <EmptyHeader>
          {load.state === 'loading' ? <><Spinner /><EmptyTitle>{t('Reading local work…')}</EmptyTitle></> : (
            <>
              <EmptyTitle>{t("Can't read local work right now")}</EmptyTitle>
              <EmptyDescription>{load.error}</EmptyDescription>
              <Button size="sm" variant="outline" className="mt-2 self-center" onClick={() => void retryWorkRead()}>{t('Retry')}</Button>
            </>
          )}
        </EmptyHeader>
      </Empty>
    </div>
  )
}

function LoadedApp() {
  const { t } = useI18n()
  const { sourceKind, requests, focusAreas } = useWorkModel()
  // Which areas are shared, for their Shared mark. The worker keeps the pages current (R17.3).
  useFocusSharesLoader(sourceKind === 'local')
  const sample = sourceKind === 'sample'
  const view = useStore((state) => state.view.section)
  const focusChoice = useStore((state) => state.view.focusChoice)
  const openRequest = useStore((state) => state.view.openRequest)
  const showSpec = useStore((state) => state.view.showSpec)
  const workspace = useWorkspace()
  const dark = useDarkMode()
  const search = useThreadSearch()
  const { goToPage, goToFocus, openRequestDrawer, closeRequestDrawer, setWorkspace, setShowSpec, setDark, playSampleDemo } = useStore.getState()
  const focusAreaId = shownFocusAreaId({ section: 'work', focusChoice }, focusAreas)
  // The drawer always shows the current record of today's requests; an older goal-only request shows as it was passed.
  const liveOpenRequest = openRequest ? requests.find((request) => request.id === openRequest.id) ?? (openRequest.fromLiveFeed === false ? openRequest.fallback : null) : null
  // The demo flip is sample data; it never runs against real requests.
  useEffect(() => (sample ? playSampleDemo() : undefined), [sample, playSampleDemo])
  const focusTitle = focusAreaId === OTHER_FOCUS_AREA_ID ? t('Other') : focusAreas.find((area) => area.id === focusAreaId)?.name
  const heading = view === 'suggested' ? t('Suggested') : view === 'past-focus' ? t('Past focus') : view === 'work' && focusTitle ? focusTitle : t(SECTION_LABEL[view])

  return (
    <MotionConfig reducedMotion="user">
      {/* Images come from the worker (this machine's, or the hosted one behind work.cmem.ai); sample mode draws fixtures. */}
      <MediaSourceContext.Provider value={sample ? SAMPLE_MEDIA_SOURCE : workerMediaSource}>
        <TooltipProvider delayDuration={150}>
          <Req ids={['R10.3', 'R10.2']} className="min-h-svh">
            <div className="min-h-svh pb-[env(safe-area-inset-bottom)] text-foreground">
              {/* Wireframe controls: not part of the product. */}
              <StickyBanner hideOnScroll className="min-h-0 flex-wrap justify-start gap-x-3 gap-y-1 border-b border-border/70 bg-card/85 px-4 py-1.5 pr-12 text-xs whitespace-nowrap backdrop-blur-md md:px-6 md:pr-10">
                {sample && <Badge variant="outline" className="font-normal">{t('Wireframe · sample data')}</Badge>}
                {sample && <Req ids={['R13.1']}>
                  <ToggleGroup type="single" size="sm" variant="outline" spacing={1} className="flex-nowrap" value={workspace.mode} onValueChange={(mode) => mode && setWorkspace({ mode: mode as 'home' | 'web', connected: mode === 'web' || workspace.connected })}>
                    <ToggleGroupItem value="home" className="h-7 text-xs">{t('At home')}<span className="hidden md:inline">{t('· localhost:37777')}</span></ToggleGroupItem>
                    <ToggleGroupItem value="web" className="h-7 text-xs">{t('On the go')}<span className="hidden md:inline">{t('· cmem.ai')}</span></ToggleGroupItem>
                  </ToggleGroup>
                </Req>}
                <div className="ml-auto flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <Switch id="dark-mode" checked={dark} onCheckedChange={setDark} />
                    <Label htmlFor="dark-mode" className="text-xs">{t('Dark')}</Label>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Switch id="spec-overlay" checked={showSpec} onCheckedChange={setShowSpec} />
                    <Label htmlFor="spec-overlay" className="text-xs">{t('Spec IDs')}</Label>
                  </div>
                </div>
              </StickyBanner>

              <header className="contents">
                <Navbar className="top-0 z-30">
                  <HeaderBody>
                    <Req ids={['R10.4']}>
                      <span className="flex shrink-0 items-center gap-2">
                        <CmemMark className="size-8 text-[#D86441]" />
                        <span className="sr-only md:not-sr-only md:text-[0.95rem] md:font-semibold md:tracking-tight">claude-mem</span>
                      </span>
                    </Req>
                    <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight whitespace-nowrap md:hidden [.header-pill_&]:text-base">{heading}</h1>
                    <PageLinks section={view} focused={!!focusAreaId} place="header" />
                    <div className="ml-auto flex shrink-0 items-center gap-0.5 md:gap-2">
                      <ThreadSearchButton onOpen={search.show} className="hidden md:inline-flex" />
                      <TeamSwitch team={workspace.team} onChange={(team) => setWorkspace({ team })} />
                      <DeviceFreshness />
                      <LiveIndicator />
                      <LanguageSelector />
                      <ClassicViewerLink />
                      <FeedbackLink />
                      <GitHubStars />
                    </div>
                  </HeaderBody>
                </Navbar>
              </header>

              <div className="mx-auto max-w-[1440px] px-4 py-4 md:px-6 md:py-6">
                <main className="min-w-0 space-y-4 md:space-y-5">
                  <PageLinks section={view} focused={!!focusAreaId} place="page" lead={<ThreadSearchButton onOpen={search.show} className="-ml-2 md:hidden" />} />
                  <Suspense fallback={<PageLoading label={heading} />}>
                    {view === 'work' && <MyWork focusAreaId={focusAreaId} onOpen={openRequestDrawer} onOpenFocus={goToFocus} onOpenRules={() => goToPage('rules')} />}
                    {view === 'suggested' && <SuggestedAreas onOpenFocus={goToFocus} />}
                    {view === 'past-focus' && <PastFocus onOpenFocus={goToFocus} />}
                    {view === 'rules' && <MyRules />}
                  </Suspense>
                </main>
              </div>

              <ThreadSearch search={search} requests={requests} focusAreas={focusAreas} sample={sample} onShow={openRequestDrawer} />

              {/* Always mounted: its code loads after first paint, and closing keeps the loaded detail for a reopen. */}
              <Suspense fallback={liveOpenRequest ? <RequestDetailLoading title={liveOpenRequest.title ?? liveOpenRequest.resolvesTo?.title ?? t('Untitled request')} onClose={closeRequestDrawer} /> : null}>
                <RequestDetail request={liveOpenRequest} onClose={closeRequestDrawer} onOpenFocus={goToFocus} />
              </Suspense>
            </div>
          </Req>
        </TooltipProvider>
      </MediaSourceContext.Provider>
    </MotionConfig>
  )
}
