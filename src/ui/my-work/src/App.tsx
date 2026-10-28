import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { MotionConfig } from 'motion/react'
import { InboxIcon, ListChecksIcon, UsersIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ActivePill, ClassicViewerLink, DeviceFreshness, GitHubStars, LiveIndicator, WorkspaceContext, type Workspace } from '@/components/bits'
import { Navbar, NavBody } from '@/components/aceternity/resizable-navbar'
import { Notch } from '@/components/aceternity/notch'
import { StickyBanner } from '@/components/aceternity/sticky-banner'
import { CmemMark } from '@/components/brand'
import { FocusChipRow, FocusRail, PastFocusLink, SIDE_NAV_PILL, type FocusSelection } from '@/components/focus-nav'
import { RequestDetail } from '@/components/request-detail'
import { cn } from '@/lib/utils'
import { PastFocus } from '@/pages/past-focus'
import { MyRules } from '@/pages/my-rules'
import { MyWork } from '@/pages/my-work'
import { SuggestedAreas } from '@/pages/suggested-areas'
import { Req, SpecOverlayContext } from '@/spec/req'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { needsYou, OTHER_FOCUS_AREA_ID, playDemoUpdates, receiveConnectionStatus, receiveLiveWorkModel, requestById, setActiveWorkDataSource, settleInitialWorkModelLoad, useWorkModel, useWorkModelLoad, type Request } from '@/data'
import { localSource } from '@/live/local-source'
import { resolveFocusAreaId } from '@/live/to-focus-model'
import { sampleSource } from '@/live/sample-source'
import { sendUsageReport, usageReport } from '@/live/usage'
import type { WorkDataSource } from '@/live/work-data-source'

/** `setup` is the install funnel (`?setup=1`): a full page outside the nav that becomes My Work when it completes. */
type Page = 'setup' | 'work' | 'rules'
type NavPage = Exclude<Page, 'setup'>
/** MY FOCUS sits above these: its areas, Other and Suggested (focus-nav.tsx). Past focus is at the bottom of the rail. */
const PAGES: { id: NavPage; label: string; icon: typeof InboxIcon; section: string }[] = [
  { id: 'work', label: 'My Work', icon: InboxIcon, section: 'Monitor' },
  { id: 'rules', label: 'My Rules', icon: ListChecksIcon, section: 'Steer' },
]
/** What the main column shows: a page, or one of the focus views the rail opens. */
type View = NavPage | 'suggested' | 'past-focus'
const NAV_SECTIONS = [...new Set(PAGES.map((entry) => entry.section))]


/** Wireframe-only theme switch: starts from ?theme=dark|light, else the system preference. */
function useDarkMode() {
  const [dark, setDark] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get('theme')
    return requested ? requested === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  useEffect(() => { document.documentElement.classList.toggle('dark', dark) }, [dark])
  return [dark, setDark] as const
}

/** Small rounded icon tile behind each nav icon, after the fly.io sidebar: a hairline with a soft tile shadow. */
function NavTile({ icon: Icon, active }: { icon: typeof InboxIcon; active: boolean }) {
  return (
    <span className={cn('relative flex size-7 shrink-0 items-center justify-center rounded-lg border shadow-tile', active ? 'border-accent-border bg-card text-primary' : 'bg-card/60 text-muted-foreground')}>
      <Icon className="size-4" />
    </span>
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
  return (
    <Req ids={['R9.1', 'R9.4']}>
      <HoverCard openDelay={100}>
        <HoverCardTrigger asChild>
          <Button variant={team ? 'secondary' : 'ghost'} size="sm" className={cn('px-2 text-xs', team && 'bg-accent text-accent-foreground hover:bg-accent')} onClick={() => onChange(!team)}><UsersIcon />Team</Button>
        </HoverCardTrigger>
        <HoverCardContent className="w-64 space-y-2 text-xs">
          <p className="font-medium">TeamBrain</p>
          <p className="text-muted-foreground">See everyone’s requests on one board, with who asked and where work collides.</p>
          {!team && <Button size="sm" className="w-full">Start team plan</Button>}
        </HoverCardContent>
      </HoverCard>
    </Req>
  )
}

/** `?source=sample` shows the fixtures; otherwise the local worker (through the dev proxy, or same origin when the worker serves this page). Never falls back to sample data. */
const ACTIVE_SOURCE: WorkDataSource = new URLSearchParams(window.location.search).get('source') === 'sample' ? sampleSource : localSource
setActiveWorkDataSource(ACTIVE_SOURCE)
/** Usage counts (the page opened on, the page switched to) describe real local work only; the sample fixtures are not usage. */
const REPORTS_USAGE = ACTIVE_SOURCE === localSource
let openReported = false

const SetupPage = lazy(() => import('@/setup/setup-page'))
export default function App() {
  // Only the explicit installer handoff opens setup. Missing state on an
  // existing installation must never lock My Work behind checkout.
  const [page, setPage] = useState<Page>(() => new URLSearchParams(window.location.search).get('setup') === '1' ? 'setup' : 'work')
  // One count for the page the viewer opened on. StrictMode runs effects twice in development; the flag keeps it to one.
  useEffect(() => {
    if (!REPORTS_USAGE || openReported) return
    openReported = true
    sendUsageReport(usageReport(page, null))
  }, [page])
  if (page !== 'setup') return <WorkApp />
  const finishSetup = () => {
    const url = new URL(window.location.href)
    url.searchParams.delete('setup')
    window.history.replaceState(null, '', url)
    window.scrollTo(0, 0)
    if (REPORTS_USAGE) sendUsageReport(usageReport('work', 'setup'))
    setPage('work')
  }
  return <MotionConfig reducedMotion="user"><Suspense fallback={null}><SetupPage onComplete={finishSetup} /></Suspense></MotionConfig>
}

/** Reads the active source once and subscribes to its live feed, then renders the app. A failed load says so plainly instead of showing anything made up. */
function WorkApp() {
  const load = useWorkModelLoad()
  useEffect(() => {
    const unsubscribe = ACTIVE_SOURCE.subscribeToLiveUpdates(receiveLiveWorkModel, receiveConnectionStatus)
    ACTIVE_SOURCE.loadWorkModel().then(
      (model) => settleInitialWorkModelLoad({ model }),
      (error: unknown) => settleInitialWorkModelLoad({ error: error instanceof Error ? error.message : String(error) }),
    )
    return unsubscribe
  }, [])
  if (load.state === 'loaded') return <LoadedApp />
  return (
    <div className="flex min-h-svh items-center justify-center p-4 text-foreground">
      <Empty className="max-w-md border bg-card/60">
        <EmptyHeader>
          {load.state === 'loading' ? <><Spinner /><EmptyTitle>Reading local work…</EmptyTitle></> : (
            <>
              <EmptyTitle>Can't read local work right now</EmptyTitle>
              <EmptyDescription>{load.error}</EmptyDescription>
            </>
          )}
        </EmptyHeader>
      </Empty>
    </div>
  )
}

function LoadedApp() {
  const { sourceKind } = useWorkModel()
  const sample = sourceKind === 'sample'
  const [view, setView] = useState<View>('work')
  // The area My Work is filtered to (an area id or Other); null shows every request. Session state only.
  const [focusChoice, setFocusChoice] = useState<string | null>(null)
  const [workspaceChoice, setWorkspace] = useState<Workspace>({ mode: 'home', team: false, connected: false })
  // Outside sample mode the place comes from the source: the local worker is at home, cmem.ai is on the go.
  const workspace: Workspace = sample ? workspaceChoice : { ...workspaceChoice, mode: sourceKind === 'cloud' ? 'web' : 'home' }
  const [showSpec, setShowSpec] = useState(false)
  const [dark, setDark] = useDarkMode()
  // Whether the opened request was in today's live feed, so the drawer can tell "left the feed" from "never in it".
  const [openRequest, setOpenRequestState] = useState<{ request: Request; fromLiveFeed: boolean } | null>(null)
  const setOpenRequest = (request: Request | null) => setOpenRequestState(request ? { request, fromLiveFeed: requestById(request.id) !== null } : null)
  const { requests, focusAreas } = useWorkModel()
  // An area merged away shows its target; a dismissed one falls back to every request.
  const focusAreaId = focusChoice === OTHER_FOCUS_AREA_ID ? focusChoice : resolveFocusAreaId(focusChoice, focusAreas)
  const yourMoveCount = requests.filter(needsYou).length
  // The drawer always shows the current state of today's requests; older goal-only requests come as passed.
  // A request that leaves the live feed closes the drawer: its agent and device may have left the model with it.
  const liveOpenRequest = openRequest ? requestById(openRequest.request.id) ?? (openRequest.fromLiveFeed ? null : openRequest.request) : null
  // Forget the closed selection, so the drawer never reopens by itself if that request later returns to the feed.
  useEffect(() => { if (openRequest && liveOpenRequest === null) setOpenRequestState(null) }, [openRequest, liveOpenRequest])
  // The demo flip is sample data; it never runs against real requests.
  useEffect(() => (sample ? playDemoUpdates() : undefined), [sample])
  // Showing another view is counted with the view it left; the same view again (including another focus area on My Work) is not a switch.
  const showView = (next: View) => { if (REPORTS_USAGE) sendUsageReport(usageReport(next, view)); setView(next) }
  const goToPage = (next: NavPage) => { setFocusChoice(null); showView(next) }
  const goToFocus = (id: string) => { setOpenRequest(null); setFocusChoice(id); showView('work') }
  const selected: FocusSelection = view === 'suggested' || view === 'past-focus' ? { kind: view } : view === 'work' && focusAreaId ? { kind: 'area', focusAreaId } : null
  const selectFocus = (selection: FocusSelection) => {
    if (!selection) goToPage('work')
    else if (selection.kind === 'area') goToFocus(selection.focusAreaId)
    else { setFocusChoice(null); showView(selection.kind) }
  }
  const pageActive = (id: NavPage) => view === id && !(id === 'work' && focusAreaId)
  const focusTitle = focusAreaId === OTHER_FOCUS_AREA_ID ? 'Other' : focusAreas.find((area) => area.id === focusAreaId)?.name
  const heading = view === 'suggested' ? 'Suggested' : view === 'past-focus' ? 'Past focus' : view === 'work' && focusTitle ? focusTitle : PAGES.find((entry) => entry.id === view)!.label

  return (
    <MotionConfig reducedMotion="user">
    <SpecOverlayContext.Provider value={showSpec}>
      <WorkspaceContext.Provider value={workspace}>
        <TooltipProvider delayDuration={150}>
          <Req ids={['R10.3', 'R10.2']} className="min-h-svh">
            <div className="min-h-svh pb-[calc(6rem+env(safe-area-inset-bottom))] text-foreground md:pb-0">
              {/* Wireframe controls: not part of the product. */}
              <StickyBanner hideOnScroll className="min-h-0 flex-wrap justify-start gap-x-3 gap-y-1 border-b border-border/70 bg-card/85 px-4 py-1.5 pr-12 text-xs whitespace-nowrap backdrop-blur-md md:px-6 md:pr-10">
                {sample && <Badge variant="outline" className="font-normal">Wireframe · sample data</Badge>}
                {sample && <Req ids={['R13.1']}>
                  <ToggleGroup type="single" size="sm" variant="outline" spacing={1} className="flex-nowrap" value={workspace.mode} onValueChange={(mode) => mode && setWorkspace({ ...workspace, mode: mode as Workspace['mode'], connected: mode === 'web' || workspace.connected })}>
                    <ToggleGroupItem value="home" className="h-7 text-xs">At home<span className="hidden md:inline">· localhost:37777</span></ToggleGroupItem>
                    <ToggleGroupItem value="web" className="h-7 text-xs">On the go<span className="hidden md:inline">· cmem.ai</span></ToggleGroupItem>
                  </ToggleGroup>
                </Req>}
                <div className="ml-auto flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <Switch id="dark-mode" checked={dark} onCheckedChange={setDark} />
                    <Label htmlFor="dark-mode" className="text-xs">Dark</Label>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Switch id="spec-overlay" checked={showSpec} onCheckedChange={setShowSpec} />
                    <Label htmlFor="spec-overlay" className="text-xs">Spec IDs</Label>
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
                      <TeamSwitch team={workspace.team} onChange={(team) => setWorkspace({ ...workspace, team })} />
                      <DeviceFreshness />
                      <LiveIndicator />
                      <ClassicViewerLink />
                      <GitHubStars />
                    </div>
                  </HeaderBody>
                </Navbar>
              </header>

              <div className="mx-auto max-w-[1440px] gap-6 px-4 py-4 md:grid md:grid-cols-[52px_minmax(0,1fr)] md:px-6 md:py-6 lg:grid-cols-[184px_minmax(0,1fr)] lg:gap-8">
                <Req ids={['R16.1']} className="hidden md:block">
                  <nav aria-label="Pages" className="sticky top-20 hidden max-h-[calc(100svh-6rem)] space-y-5 self-start overflow-y-auto md:block">
                    <div className="hidden lg:block"><FocusRail selected={selected} onSelect={selectFocus} /></div>
                    {NAV_SECTIONS.map((section) => (
                      <div key={section} className="space-y-0.5">
                        <p className="section-label hidden px-2 pb-1 lg:block">{section}</p>
                        {PAGES.filter((entry) => entry.section === section).map(({ id, label, icon }) => (
                          <button key={id} type="button" onClick={() => goToPage(id)} aria-current={pageActive(id) ? 'page' : undefined} title={label} className={cn('relative flex h-10 w-full items-center gap-2.5 rounded-[10px] px-1.5 text-left text-[0.9rem] transition-colors', pageActive(id) ? 'font-medium text-accent-foreground' : 'text-foreground/85 hover:bg-card/70')}>
                            {pageActive(id) && <ActivePill layoutId={SIDE_NAV_PILL} />}
                            <NavTile icon={icon} active={pageActive(id)} />
                            <span className="relative hidden lg:inline">{label}</span>
                            {id === 'work' && yourMoveCount > 0 && <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground lg:relative lg:top-auto lg:right-auto lg:ml-auto lg:h-5 lg:min-w-5 lg:text-[11px]">{yourMoveCount}<span className="sr-only"> need you</span></span>}
                          </button>
                        ))}
                      </div>
                    ))}
                    <div className="hidden border-t border-border/70 pt-3 lg:block"><PastFocusLink selected={selected} onSelect={selectFocus} /></div>
                  </nav>
                </Req>

                <main className="min-w-0 space-y-4 md:space-y-5">
                  <FocusChipRow selected={selected} onSelect={selectFocus} />
                  {view === 'work' && <MyWork focusAreaId={focusAreaId} onOpen={setOpenRequest} onOpenFocus={goToFocus} onOpenRules={() => goToPage('rules')} />}
                  {view === 'suggested' && <SuggestedAreas onOpenFocus={goToFocus} />}
                  {view === 'past-focus' && <PastFocus onOpenFocus={goToFocus} />}
                  {view === 'rules' && <MyRules />}
                </main>
              </div>

              <Req ids={['R11.1']} className="md:hidden">
                <nav aria-label="Pages" className="relative z-30 md:hidden">
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
                      options: [{ id, label }],
                      onChange: () => goToPage(id),
                      label: (
                        <>
                          {pageActive(id) && <ActivePill layoutId="bottom-nav-active-pill" className="rounded-xl" />}
                          <span className={cn('relative flex flex-col items-center gap-1', pageActive(id) ? 'font-semibold text-accent-foreground' : 'text-muted-foreground')}>
                            <NavTile icon={icon} active={pageActive(id)} />{label}
                          </span>
                          {id === 'work' && yourMoveCount > 0 && <span className="absolute top-1.5 left-[calc(50%+6px)] flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">{yourMoveCount}<span className="sr-only"> need you</span></span>}
                        </>
                      ),
                    }))}
                  />
                </nav>
              </Req>

              <RequestDetail request={liveOpenRequest} onClose={() => setOpenRequest(null)} onOpenFocus={goToFocus} />
            </div>
          </Req>
        </TooltipProvider>
      </WorkspaceContext.Provider>
    </SpecOverlayContext.Provider>
    </MotionConfig>
  )
}
