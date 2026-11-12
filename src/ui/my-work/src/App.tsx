import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { MotionConfig } from 'motion/react'
import { CreditCardIcon, InboxIcon, ListChecksIcon, UsersIcon } from 'lucide-react'
import { LOCALES, LOCALE_NAMES, useI18n, type Locale } from '@/lib/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ActivePill, ClassicViewerLink, DeviceFreshness, FeedbackLink, GitHubStars, LiveIndicator } from '@/components/bits'
import { Navbar, NavBody } from '@/components/aceternity/resizable-navbar'
import { Notch } from '@/components/aceternity/notch'
import { StickyBanner } from '@/components/aceternity/sticky-banner'
import { CmemMark } from '@/components/brand'
import { FocusChipRow, FocusRail, PastFocusLink, SIDE_NAV_PILL } from '@/components/focus-nav'
import { cn } from '@/lib/utils'
import { MyWork } from '@/pages/my-work'
import { Req } from '@/spec/req'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { needsYou, OTHER_FOCUS_AREA_ID } from '@/data'
import { ACTIVE_SOURCE, useStore, useWorkModel, useWorkspace, type FocusSelection, type NavPage } from '@/store'
import { shownFocusAreaId } from '@/store/slices/view-slice'
import { useFocusSharesLoader } from '@/live/focus-shares'
import { isServedFromCloud } from '@/live/served-from'
import { MediaSourceContext } from '@/components/observation-media/ObsMedia'
import { SAMPLE_MEDIA_SOURCE } from '@/components/observation-media/sample-media'
import { workerMediaSource } from '@/components/observation-media/worker-media-source'
/** MY FOCUS sits above these: its areas, Other and Suggested (focus-nav.tsx). Past focus is at the bottom of the rail. */
const PAGES: { id: NavPage; label: string; icon: typeof InboxIcon; section: string }[] = [
  { id: 'work', label: 'My Work', icon: InboxIcon, section: 'Monitor' },
  { id: 'rules', label: 'My Rules', icon: ListChecksIcon, section: 'Steer' },
]
const NAV_SECTIONS = [...new Set(PAGES.map((entry) => entry.section))]
/** Billing, cancel, card and synced devices live on cmem.ai; viewer accounts land here and have no other way there. */
const ACCOUNT_AND_BILLING_URL = 'https://cmem.ai/account'


/** Wireframe-only theme switch: starts from ?theme=dark|light, else the system preference. */
function useDarkMode() {
  const dark = useStore((state) => state.view.dark)
  useEffect(() => { document.documentElement.classList.toggle('dark', dark) }, [dark])
  return dark
}

/** Small rounded icon tile behind each nav icon, after the fly.io sidebar: a hairline with a soft tile shadow. */
function NavTile({ icon: Icon, active }: { icon: typeof InboxIcon; active: boolean }) {
  return (
    <span className={cn('relative flex size-7 shrink-0 items-center justify-center rounded-lg border shadow-tile', active ? 'border-accent-border bg-card text-primary' : 'bg-card/60 text-muted-foreground')}>
      <Icon className="size-4" />
    </span>
  )
}

/** Bottom of the rail, cloud viewer only (R18.1). Same row markup as the pages above it; local My Work has no cmem.ai account to manage. */
function AccountAndBillingLink() {
  if (!isServedFromCloud(window.location.hostname)) return null
  return (
    <Req ids={['R18.1']}>
      <a href={ACCOUNT_AND_BILLING_URL} title="Account & billing" className="relative flex h-10 w-full items-center gap-2.5 rounded-[10px] px-1.5 text-left text-[0.9rem] text-foreground/85 transition-colors hover:bg-card/70">
        <NavTile icon={CreditCardIcon} active={false} />
        <span className="relative hidden lg:inline">Account &amp; billing</span>
      </a>
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
  const { goToPage, goToFocus, selectFocus, openRequestDrawer, closeRequestDrawer, setWorkspace, setShowSpec, setDark, playSampleDemo } = useStore.getState()
  const focusAreaId = shownFocusAreaId({ section: 'work', focusChoice }, focusAreas)
  const yourMoveCount = requests.filter(needsYou).length
  // The drawer always shows the current record of today's requests; an older goal-only request shows as it was passed.
  const liveOpenRequest = openRequest ? requests.find((request) => request.id === openRequest.id) ?? (openRequest.fromLiveFeed === false ? openRequest.fallback : null) : null
  // The demo flip is sample data; it never runs against real requests.
  useEffect(() => (sample ? playSampleDemo() : undefined), [sample, playSampleDemo])
  const selected: FocusSelection = view === 'suggested' || view === 'past-focus' ? { kind: view } : view === 'work' && focusAreaId ? { kind: 'area', focusAreaId } : null
  const pageActive = (id: NavPage) => view === id && !(id === 'work' && focusAreaId)
  const focusTitle = focusAreaId === OTHER_FOCUS_AREA_ID ? t('Other') : focusAreas.find((area) => area.id === focusAreaId)?.name
  const heading = view === 'suggested' ? t('Suggested') : view === 'past-focus' ? t('Past focus') : view === 'work' && focusTitle ? focusTitle : t(PAGES.find((entry) => entry.id === view)!.label)

  return (
    <MotionConfig reducedMotion="user">
      {/* Images come from the worker (this machine's, or the hosted one behind work.cmem.ai); sample mode draws fixtures. */}
      <MediaSourceContext.Provider value={sample ? SAMPLE_MEDIA_SOURCE : workerMediaSource}>
        <TooltipProvider delayDuration={150}>
          <Req ids={['R10.3', 'R10.2']} className="min-h-svh">
            <div className="min-h-svh pb-[calc(6rem+env(safe-area-inset-bottom))] text-foreground md:pb-0">
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
                    <div className="ml-auto flex shrink-0 items-center gap-0.5 md:gap-2">
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

              <div className="mx-auto max-w-[1440px] gap-6 px-4 py-4 md:grid md:grid-cols-[52px_minmax(0,1fr)] md:px-6 md:py-6 lg:grid-cols-[184px_minmax(0,1fr)] lg:gap-8">
                <Req ids={['R16.1']} className="hidden md:block">
                  <nav aria-label={t('Pages')} className="sticky top-20 hidden max-h-[calc(100svh-6rem)] space-y-5 self-start overflow-y-auto md:block">
                    <div className="hidden lg:block"><FocusRail selected={selected} onSelect={selectFocus} /></div>
                    {NAV_SECTIONS.map((section) => (
                      <div key={section} className="space-y-0.5">
                        <p className="section-label hidden px-2 pb-1 lg:block">{t(section)}</p>
                        {PAGES.filter((entry) => entry.section === section).map(({ id, label, icon }) => (
                          <button key={id} type="button" onClick={() => goToPage(id)} aria-current={pageActive(id) ? 'page' : undefined} title={t(label)} className={cn('relative flex h-10 w-full items-center gap-2.5 rounded-[10px] px-1.5 text-left text-[0.9rem] transition-colors', pageActive(id) ? 'font-medium text-accent-foreground' : 'text-foreground/85 hover:bg-card/70')}>
                            {pageActive(id) && <ActivePill layoutId={SIDE_NAV_PILL} />}
                            <NavTile icon={icon} active={pageActive(id)} />
                            <span className="relative hidden lg:inline">{t(label)}</span>
                            {id === 'work' && yourMoveCount > 0 && <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground lg:relative lg:top-auto lg:right-auto lg:ml-auto lg:h-5 lg:min-w-5 lg:text-[11px]">{yourMoveCount}<span className="sr-only"> {t('need you')}</span></span>}
                          </button>
                        ))}
                      </div>
                    ))}
                    <div className="hidden border-t border-border/70 pt-3 lg:block"><PastFocusLink selected={selected} onSelect={selectFocus} /></div>
                    <AccountAndBillingLink />
                  </nav>
                </Req>

                <main className="min-w-0 space-y-4 md:space-y-5">
                  <FocusChipRow selected={selected} onSelect={selectFocus} />
                  <Suspense fallback={<PageLoading label={heading} />}>
                    {view === 'work' && <MyWork focusAreaId={focusAreaId} onOpen={openRequestDrawer} onOpenFocus={goToFocus} onOpenRules={() => goToPage('rules')} />}
                    {view === 'suggested' && <SuggestedAreas onOpenFocus={goToFocus} />}
                    {view === 'past-focus' && <PastFocus onOpenFocus={goToFocus} />}
                    {view === 'rules' && <MyRules />}
                  </Suspense>
                </main>
              </div>

              <Req ids={['R11.1']} className="md:hidden">
                <nav aria-label={t('Pages')} className="relative z-30 md:hidden">
                  <Notch
                    reveal={false}
                    showSelectedValue={false}
                    showDividers={false}
                    offset={12}
                    className="rounded-2xl border-border/70 bg-card/95 shadow-panel ring-border/60"
                    itemClassName="relative h-[60px] min-w-24 flex-col justify-center gap-1 rounded-xl px-3 text-[11px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                    items={PAGES.map(({ id, label, icon }) => ({
                      id,
                      currentPage: pageActive(id),
                      options: [{ id, label: t(label) }],
                      onChange: () => goToPage(id),
                      label: (
                        <>
                          {pageActive(id) && <ActivePill layoutId="bottom-nav-active-pill" className="rounded-xl" />}
                          <span className={cn('relative flex flex-col items-center gap-1', pageActive(id) ? 'font-semibold text-accent-foreground' : 'text-muted-foreground')}>
                            <NavTile icon={icon} active={pageActive(id)} />{t(label)}
                          </span>
                          {id === 'work' && yourMoveCount > 0 && <span className="absolute top-1.5 left-[calc(50%+6px)] flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">{yourMoveCount}<span className="sr-only"> {t('need you')}</span></span>}
                        </>
                      ),
                    }))}
                  />
                </nav>
              </Req>

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
