import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { MotionConfig } from 'motion/react'
import { CreditCardIcon, CrosshairIcon, FlaskConicalIcon, InboxIcon, ListChecksIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { useAppliedTheme } from '@/lib/use-applied-theme'
import { Button } from '@/components/ui/button'
import { RequestDrawerLoading, RequestDrawerSheet } from '@/components/request-drawer'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ActivePill, ClassicViewerLink, DeviceFreshness, LiveIndicator, ReadAfterSaveNotice } from '@/components/bits'
import { AppBrand, ShellGrid, ShellLoading, ShellReadError } from '@/components/app-shell'
import { HeaderMenu } from '@/components/header-menu'
import { CloudTrialBanner } from '@/components/cloud-trial-banner'
import { CloudTrialGuide } from '@/components/cloud-trial-guide'
import { sharedViewerOwner } from '@/live/shared-viewer-session'
import { useCloudTrial } from '@/live/use-cloud-trial'
import { Navbar, NavBody } from '@/components/aceternity/resizable-navbar'
import { Notch } from '@/components/aceternity/notch'
import { StickyBanner } from '@/components/aceternity/sticky-banner'
import { FocusChipRow, FocusRail, PastFocusLink, SIDE_NAV_PILL } from '@/components/focus-nav'
import { cn } from '@/lib/utils'
import { MyWork } from '@/pages/my-work'
import { Req } from '@/spec/req'
import { Spinner } from '@/components/ui/spinner'
import { needsYou, OTHER_FOCUS_AREA_ID } from '@/data'
import { ACTIVE_SOURCE, useStore, useWorkModel, useWorkspace, type FocusSelection, type NavPage } from '@/store'
import { shownFocusAreaId, themeChoiceInUse } from '@/store/slices/view-slice'
import { focusSharesAreADemonstration, useFocusSharesLoader } from '@/live/focus-shares'
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

/**
 * Small rounded icon tile behind each nav icon. Its edge shows in every state at ≥3:1 (c-shell-nav-tile: the hairline
 * was 1.66:1): the control edge at rest, the accent text colour when selected. No tile shadow of its own, so cards and
 * panels keep the only two shadows (F elevation-consistent).
 */
function NavTile({ icon: Icon, active }: { icon: typeof InboxIcon; active: boolean }) {
  return (
    <span className={cn('relative flex size-7 shrink-0 items-center justify-center rounded-lg border bg-card', active ? 'border-accent-foreground text-primary' : 'border-control-edge text-muted-foreground')}>
      <Icon className="size-4" />
    </span>
  )
}

/**
 * A page row of the rail. 46.75px tall where the rail shows only tiles (768–1023px): a 44px hit area
 * (c-shell-nav-tile); on touch the Button's own rule keeps every row at 44px or more.
 */
const RAIL_PAGE_ROW_CLASS_NAME = 'relative flex h-11 w-full items-center gap-2.5 rounded-[10px] px-1.5 text-[0.9rem] transition-colors lg:h-10'

/**
 * Bottom of the rail, cloud viewer only (R18.1); local My Work has no cmem.ai account to manage. The same row as the
 * pages above it: its name stays where the rail shows only the tile, and a tooltip names it there on hover and focus.
 */
function AccountAndBillingLink() {
  const { t } = useI18n()
  if (!isServedFromCloud(window.location.hostname)) return null
  return (
    <Req ids={['R18.1']}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild variant="bare" className={cn(RAIL_PAGE_ROW_CLASS_NAME, 'text-foreground/85 hover:bg-card/70')}>
            <a href={ACCOUNT_AND_BILLING_URL}>
              <NavTile icon={CreditCardIcon} active={false} />
              <span className="relative hidden lg:inline">{t('Account & billing')}</span>
              <span className="sr-only lg:hidden">{t('Account & billing')}</span>
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" className="lg:hidden">{t('Account & billing')}</TooltipContent>
      </Tooltip>
    </Req>
  )
}

/**
 * The header bar: full width at the top of the page, a floating pill once the page scrolls (`Navbar` passes
 * `visible`). The pill holds the logo, the page name, Live, how many need you, the machines and the menu, and nothing
 * sticks out of it at any width (c-shell-resizable-navbar). `children` draws for the bar or the pill.
 */
function HeaderBody({ visible, children }: { visible?: boolean; children: (pill: boolean) => ReactNode }) {
  return (
    // Phones: the pill is 2rem narrower than the bar, so it trims its padding and gaps, and the page title gives way first.
    <NavBody visible={visible} className={cn('flex h-14 max-w-[1440px] gap-3 bg-card/95 px-4 py-0 md:px-6', visible ? 'header-pill gap-1.5 border border-border/70 px-2.5 md:gap-3 md:px-6' : 'rounded-none border-b border-border/70')}>
      {children(!!visible)}
    </NavBody>
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

/**
 * Opening a request responds immediately, including focus trapping and a working close control: the drawer's own frame
 * and loading shape (components/request-drawer.tsx), while its code arrives. It keeps what opened the drawer, so focus
 * goes back there when the drawer closes (F 344).
 */
function RequestDetailLoading({ title, onClose }: { title: string; onClose: () => void }) {
  return <RequestDrawerSheet onClose={onClose}><RequestDrawerLoading title={title} /></RequestDrawerSheet>
}

export default function App() {
  // An agent may leave setup for the person's first visit. Only a persisted
  // install handoff opens it automatically; old installations and cloud readers keep My Work.
  const page = useStore((state) => state.view.page)
  // A `?theme=` address for this visit, else the person's saved choice (G8); the address one is never saved.
  const theme = useStore((state) => themeChoiceInUse(state.view))
  const finishSetup = useStore.use.finishSetup()
  // G8: one theme for every screen, the loading and failed ones included; setup keeps its own light canvas.
  useAppliedTheme(theme, page === 'setup')
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

/**
 * Reads the active source once and follows its live feed, then renders the app. While the first read is open the
 * page shows its own shape; a failed read says so plainly instead of showing anything made up (page-06).
 */
function WorkApp() {
  const load = useStore((state) => state.work.load)
  const startWorkSource = useStore.use.startWorkSource()
  const retryWorkRead = useStore.use.retryWorkRead()
  // "Try again" leaves the page with the failed screen, so the screen that answers the retry takes focus: the next
  // failed screen's Try again, or the loaded page's main content. Without it focus fell to the page body (WCAG 2.4.3).
  const [retried, setRetried] = useState(false)
  useEffect(() => startWorkSource(ACTIVE_SOURCE), [startWorkSource])
  if (load.state === 'loaded') return <LoadedApp focusMainOnMount={retried} />
  if (load.state === 'loading') return <ShellLoading />
  return <ShellReadError cause={load.error} focusRetry={retried} onRetry={() => { setRetried(true); void retryWorkRead() }} />
}

/** The same page without `?source=sample`: the person's own work. */
function ownDataHref(): string {
  const url = new URL(window.location.href)
  url.searchParams.delete('source')
  return url.href
}

/** `focusMainOnMount`: the page loaded after the person pressed Try again, so focus starts at its main content. */
function LoadedApp({ focusMainOnMount = false }: { focusMainOnMount?: boolean }) {
  const { t } = useI18n()
  const mainRef = useRef<HTMLElement>(null)
  useEffect(() => { if (focusMainOnMount) mainRef.current?.focus({ preventScroll: true }) }, [focusMainOnMount])
  const { sourceKind, requests, focusAreas } = useWorkModel()
  // Which areas are shared, for their Shared mark. The worker keeps the pages current (R17.3). The sample page reads
  // them only in its sharing demonstration (`sample-state=area-shared`), answered in the page.
  useFocusSharesLoader(sourceKind === 'local' || focusSharesAreADemonstration())
  const sample = sourceKind === 'sample'
  const owner = sharedViewerOwner()
  const trial = useCloudTrial(sourceKind === 'cloud' && !!owner)
  const view = useStore((state) => state.view.section)
  const focusChoice = useStore((state) => state.view.focusChoice)
  const openRequest = useStore((state) => state.view.openRequest)
  const homeAnchor = useStore((state) => state.view.homeAnchor)
  const homeAnchorRequest = useStore((state) => state.view.homeAnchorRequest)
  const workspace = useWorkspace()
  const { goToPage, goToFocus, goToHome, selectFocus, openRequestDrawer, closeRequestDrawer, setWorkspace, playSampleDemo } = useStore.getState()
  const focusAreaId = shownFocusAreaId({ section: 'work', focusChoice }, focusAreas)
  const yourMoveCount = requests.filter(needsYou).length
  // The drawer always shows the current record of today's requests; an older goal-only request shows as it was passed.
  const liveOpenRequest = openRequest ? requests.find((request) => request.id === openRequest.id) ?? (openRequest.fromLiveFeed === false ? openRequest.fallback : null) : null
  // The demo flip is sample data; it never runs against real requests.
  useEffect(() => (sample ? playSampleDemo() : undefined), [sample, playSampleDemo])
  // Each ask for a home anchor scrolls to it once the page has drawn it (an address opened with one, or a link to it).
  // Back and Forward restore the scroll position themselves and do not count as an ask.
  useEffect(() => {
    if (!homeAnchorRequest) return
    const target = document.getElementById(homeAnchorRequest.anchor)
    if (!target) { console.warn(`[my-work] home anchor #${homeAnchorRequest.anchor} is not on the page`); return }
    target.scrollIntoView({ block: 'start' })
  }, [homeAnchorRequest])
  const selected: FocusSelection = view === 'suggested' || view === 'past-focus' ? { kind: view } : view === 'work' && focusAreaId ? { kind: 'area', focusAreaId } : null
  const pageActive = (id: NavPage) => view === id && !(id === 'work' && focusAreaId)
  const onHome = view === 'work' && !focusAreaId
  const focusTitle = focusAreaId === OTHER_FOCUS_AREA_ID ? t('Other') : focusAreas.find((area) => area.id === focusAreaId)?.name
  const heading = view === 'suggested' ? t('Suggested') : view === 'past-focus' ? t('Past focus') : view === 'work' && focusTitle ? focusTitle : t(PAGES.find((entry) => entry.id === view)!.label)
  // A rail or bottom-bar page entry: My Work goes to every request on the home page (`/#all-requests`), so it has an
  // address apart from "Focus overview" (`/`, page-02 deep-linking).
  const openPage = (id: NavPage) => id === 'work' ? goToHome('all-requests') : goToPage(id)
  const showAllAreas = () => goToHome('focus-areas')
  // The bottom bar's three places. Focus covers the focus views and the home page's focus board.
  const bottomItems = [
    { id: 'work', label: 'My Work', icon: InboxIcon, current: onHome && homeAnchor !== 'focus-areas', open: () => openPage('work'), count: yourMoveCount },
    { id: 'focus', label: 'Focus', icon: CrosshairIcon, current: selected !== null || (onHome && homeAnchor === 'focus-areas'), open: showAllAreas, count: 0 },
    { id: 'rules', label: 'My Rules', icon: ListChecksIcon, current: view === 'rules', open: () => openPage('rules'), count: 0 },
  ]

  return (
    <MotionConfig reducedMotion="user">
      {/* Images come from the worker (this machine's, or the hosted one behind work.cmem.ai); sample mode draws fixtures. */}
      <MediaSourceContext.Provider value={sample ? SAMPLE_MEDIA_SOURCE : workerMediaSource}>
        <TooltipProvider delayDuration={150}>
          <Req ids={['R10.3', 'R10.2']} className="min-h-svh">
            {/* `data-slot="work-shell"` turns on the scroll padding in index.css that keeps a focused control clear of the
                header and the phone's bottom bar (c-shell-resizable-navbar, c-shell-notch F focus-not-obscured). */}
            <div data-slot="work-shell" className="min-h-svh pb-[calc(6rem+env(safe-area-inset-bottom))] text-foreground md:pb-0">
              {/* The first Tab stop (c-shell-resizable-navbar F skip-links), as in setup (setup-page.tsx). */}
              <a href="#main-content" className="sr-only rounded-lg border border-control-edge bg-card px-4 py-2.5 text-sm font-medium text-foreground shadow-popover outline-none focus:not-sr-only focus:fixed focus:top-3 focus:left-4 focus:z-[200] focus-visible:ring-3 focus-visible:ring-ring/50">
                {t('Skip to content')}
              </a>
              {owner && trial.trialEndsAt && <CloudTrialBanner owner={owner} trialEndsAt={trial.trialEndsAt} />}
              {/* The demonstration strip and its At home / On the go switch belong to the sample workspace. */}
              {sample && (
                <StickyBanner hideOnScroll className="min-h-0 flex-wrap justify-start gap-x-3 gap-y-1.5 border-b border-border/70 bg-card/85 px-4 py-1.5 pr-12 text-xs whitespace-nowrap backdrop-blur-md md:px-6 md:pr-10">
                  <span className="inline-flex items-center gap-1.5 font-medium"><FlaskConicalIcon aria-hidden="true" className="size-4 text-muted-foreground" />{t('Sample data · not your work')}</span>
                  <Req ids={['R13.1']}>
                    <ToggleGroup type="single" size="sm" variant="outline" spacing={1} className="flex-nowrap" value={workspace.mode} onValueChange={(mode) => mode && setWorkspace({ mode: mode as 'home' | 'web', connected: mode === 'web' || workspace.connected })}>
                      <ToggleGroupItem value="home" className="text-xs">{t('At home')}<span className="hidden md:inline">{t('· localhost:37777')}</span></ToggleGroupItem>
                      <ToggleGroupItem value="web" className="text-xs">{t('On the go')}<span className="hidden md:inline">{t('· cmem.ai')}</span></ToggleGroupItem>
                    </ToggleGroup>
                  </Req>
                  <Button asChild variant="outline" size="sm" className="text-xs"><a href={ownDataHref()}>{t('Use my data')}</a></Button>
                </StickyBanner>
              )}

              <header className="contents">
                <Navbar className="top-0 z-30">
                  <HeaderBody>
                    {(pill) => (
                      <>
                        <Req ids={['R10.4']}><AppBrand /></Req>
                        {/* The page's one h1, visible at every width (page-02 F heading-hierarchy: it was hidden from md up). */}
                        <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight whitespace-nowrap md:border-l md:border-border/70 md:pl-3 md:text-[0.95rem] [.header-pill_&]:text-base md:[.header-pill_&]:text-[0.95rem]">{heading}</h1>
                        <div className="ml-auto flex shrink-0 items-center gap-1 md:gap-2">
                          <LiveIndicator />
                          {/* The pill says how many need you (c-shell-resizable-navbar M); the top of the page shows them. */}
                          {pill && yourMoveCount > 0 && (
                            <span className="hidden items-center gap-1.5 text-xs text-muted-foreground md:inline-flex">
                              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground tabular">{yourMoveCount}</span>
                              {t('need you')}
                            </span>
                          )}
                          <DeviceFreshness />
                          {!pill && <ClassicViewerLink />}
                          <HeaderMenu classicViewerInBar={!pill} />
                        </div>
                      </>
                    )}
                  </HeaderBody>
                </Navbar>
              </header>

              {/* The loading and failed screens draw the same grid (app-shell.tsx), so the page keeps its shape. */}
              <ShellGrid>
                <Req ids={['R16.1']} className="hidden md:block">
                  <nav aria-label={t('Pages')} className="sticky top-20 hidden max-h-[calc(100svh-6rem)] space-y-5 self-start overflow-y-auto md:block">
                    <div className="hidden lg:block"><FocusRail selected={selected} onSelect={selectFocus} onShowAllAreas={showAllAreas} /></div>
                    {NAV_SECTIONS.map((section) => (
                      <div key={section} className="space-y-0.5">
                        <p className="section-label hidden px-2 pb-1 lg:block">{t(section)}</p>
                        {PAGES.filter((entry) => entry.section === section).map(({ id, label, icon }) => {
                          const count = id === 'work' ? yourMoveCount : 0
                          return (
                            <Tooltip key={id}>
                              <TooltipTrigger asChild>
                                <Button variant="bare" onClick={() => openPage(id)} aria-current={pageActive(id) ? 'page' : undefined}
                                  className={cn(RAIL_PAGE_ROW_CLASS_NAME, pageActive(id) ? 'font-medium text-accent-foreground' : 'text-foreground/85 hover:bg-card/70')}>
                                  {pageActive(id) && <ActivePill layoutId={SIDE_NAV_PILL} look="rail" />}
                                  <NavTile icon={icon} active={pageActive(id)} />
                                  <span className="relative hidden lg:inline">{t(label)}</span>
                                  {/* Where the rail shows only tiles, the page's name is still the button's name. */}
                                  <span className="sr-only lg:hidden">{t(label)}</span>
                                  {/* A compact count, as the tile mockup draws it: the 184px rail has no room for words beside
                                      "My Work" (the focus rows above carry them). */}
                                  {count > 0 && <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground tabular lg:relative lg:top-auto lg:right-auto lg:ml-auto lg:h-5 lg:min-w-5 lg:text-[11px]">{count}<span className="sr-only"> {t('need you')}</span></span>}
                                </Button>
                              </TooltipTrigger>
                              {/* Where the rail shows only tiles, the tooltip names the page with its count. */}
                              <TooltipContent side="right" className="lg:hidden">
                                {t(label)}{count > 0 && <> · {interpolate(t('{count} need you'), { count })}</>}
                              </TooltipContent>
                            </Tooltip>
                          )
                        })}
                      </div>
                    ))}
                    <div className="hidden border-t border-border/70 pt-3 lg:block"><PastFocusLink selected={selected} onSelect={selectFocus} /></div>
                    <AccountAndBillingLink />
                  </nav>
                </Req>

                <main ref={mainRef} id="main-content" tabIndex={-1} className="min-w-0 space-y-4 outline-none md:space-y-5">
                  {onHome && trial.onboarding && <CloudTrialGuide key={trial.onboarding.startedAt} startedAt={trial.onboarding.startedAt} />}
                  <FocusChipRow selected={selected} onSelect={selectFocus} onShowAllAreas={showAllAreas} />
                  {/* A save whose follow-up read failed, on whichever page made it (store work.readAfterSaveFailure). */}
                  <ReadAfterSaveNotice />
                  <Suspense fallback={<PageLoading label={heading} />}>
                    {view === 'work' && <MyWork focusAreaId={focusAreaId} onOpen={openRequestDrawer} onReply={(request) => openRequestDrawer(request, { reply: true })} onOpenFocus={goToFocus} onOpenRules={() => goToPage('rules')} />}
                    {view === 'suggested' && <SuggestedAreas onOpenFocus={goToFocus} />}
                    {view === 'past-focus' && <PastFocus onOpenFocus={goToFocus} />}
                    {view === 'rules' && <MyRules />}
                  </Suspense>
                </main>
              </ShellGrid>

              {/* Phones: pinned to the bottom edge with the safe area inside it, so the page (its 6rem bottom padding) ends
                  above it; labels 12px; and a third place, Focus (c-shell-notch). */}
              <Req ids={['R11.1']} className="md:hidden">
                <nav aria-label={t('Pages')} className="relative z-30 md:hidden">
                  <Notch
                    pinned
                    reveal={false}
                    showSelectedValue={false}
                    showDividers={false}
                    className="border-x-0 border-t border-b-0 border-border/70 bg-card/95 shadow-none ring-0"
                    itemClassName="relative h-[60px] min-w-24 flex-1 flex-col justify-center gap-1 rounded-xl px-3 text-xs text-muted-foreground outline-none hover:bg-accent/40 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                    items={bottomItems.map(({ id, label, icon: Icon, current, open, count }) => ({
                      id,
                      currentPage: current,
                      options: [{ id, label: t(label) }],
                      onChange: open,
                      label: (
                        <>
                          {current && <ActivePill layoutId="bottom-nav-active-pill" look="outline" className="rounded-xl" />}
                          <span className={cn('relative flex flex-col items-center gap-1', current ? 'font-semibold text-accent-foreground' : 'text-muted-foreground')}>
                            <NavTile icon={Icon} active={current} />{t(label)}
                          </span>
                          {count > 0 && <span className="absolute top-1.5 left-[calc(50%+6px)] flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground tabular">{count}<span className="sr-only"> {t('need you')}</span></span>}
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
