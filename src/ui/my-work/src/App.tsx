import { lazy, Suspense, useEffect, useState } from 'react'
import { MotionConfig } from 'motion/react'
import { GoalIcon, InboxIcon, ListChecksIcon, UsersIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ClassicViewerLink, DeviceFreshness, GitHubStars, LiveIndicator, WorkspaceContext, type Workspace } from '@/components/bits'
import { CmemMark } from '@/components/brand'
import { RequestDetail } from '@/components/request-detail'
import { cn } from '@/lib/utils'
import { MyGoals } from '@/pages/my-goals'
import { MyRules } from '@/pages/my-rules'
import { MyWork } from '@/pages/my-work'
import { Req, SpecOverlayContext } from '@/spec/req'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { playDemoUpdates, receiveConnectionStatus, receiveLiveWorkModel, requestById, setActiveWorkDataSource, settleInitialWorkModelLoad, useWorkModel, useWorkModelLoad, type Request } from '@/data'
import { localSource } from '@/live/local-source'
import { sampleSource } from '@/live/sample-source'
import type { WorkDataSource } from '@/live/work-data-source'

/** `setup` is the install funnel (`?setup=1`): a full page outside the nav that becomes My Work when it completes. */
type Page = 'setup' | 'work' | 'goals' | 'rules'
type NavPage = Exclude<Page, 'setup'>
const PAGES: { id: NavPage; label: string; icon: typeof InboxIcon; section: string }[] = [
  { id: 'work', label: 'My Work', icon: InboxIcon, section: 'Monitor' },
  { id: 'goals', label: 'My Goals', icon: GoalIcon, section: 'Steer' },
  { id: 'rules', label: 'My Rules', icon: ListChecksIcon, section: 'Steer' },
]
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

/** Small rounded icon tile behind each nav icon, after the fly.io sidebar. Flat: a hairline, no shadow. */
function NavTile({ icon: Icon, active }: { icon: typeof InboxIcon; active: boolean }) {
  return (
    <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg border', active ? 'border-accent-border bg-card text-primary' : 'bg-card/60 text-muted-foreground')}>
      <Icon className="size-4" />
    </span>
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

const SetupPage = lazy(() => import('@/setup/setup-page'))
export default function App() {
  // Only the explicit installer handoff opens setup. Missing state on an
  // existing installation must never lock My Work behind checkout.
  const [page, setPage] = useState<Page>(() => new URLSearchParams(window.location.search).get('setup') === '1' ? 'setup' : 'work')
  if (page !== 'setup') return <WorkApp />
  const finishSetup = () => {
    const url = new URL(window.location.href)
    url.searchParams.delete('setup')
    window.history.replaceState(null, '', url)
    window.scrollTo(0, 0)
    setPage('work')
  }
  return <Suspense fallback={null}><SetupPage onComplete={finishSetup} /></Suspense>
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
  const [page, setPage] = useState<NavPage>('work')
  const [workspaceChoice, setWorkspace] = useState<Workspace>({ mode: 'home', team: false, connected: false })
  // Outside sample mode the place comes from the source: the local worker is at home, cmem.ai is on the go.
  const workspace: Workspace = sample ? workspaceChoice : { ...workspaceChoice, mode: sourceKind === 'cloud' ? 'web' : 'home' }
  const [showSpec, setShowSpec] = useState(false)
  const [dark, setDark] = useDarkMode()
  // Whether the opened request was in today's live feed, so the drawer can tell "left the feed" from "never in it".
  const [openRequest, setOpenRequestState] = useState<{ request: Request; fromLiveFeed: boolean } | null>(null)
  const setOpenRequest = (request: Request | null) => setOpenRequestState(request ? { request, fromLiveFeed: requestById(request.id) !== null } : null)
  const [focusGoalId, setFocusGoalId] = useState<string | undefined>()
  const { requests } = useWorkModel()
  const yourMoveCount = requests.filter((request) => request.state === 'your-move' || request.state === 'needs-check').length
  // The drawer always shows the current state of today's requests; older goal-only requests come as passed.
  // A request that leaves the live feed closes the drawer: its agent and device may have left the model with it.
  const liveOpenRequest = openRequest ? requestById(openRequest.request.id) ?? (openRequest.fromLiveFeed ? null : openRequest.request) : null
  // Forget the closed selection, so the drawer never reopens by itself if that request later returns to the feed.
  useEffect(() => { if (openRequest && liveOpenRequest === null) setOpenRequestState(null) }, [openRequest, liveOpenRequest])
  // The demo flip is sample data; it never runs against real requests.
  useEffect(() => (sample ? playDemoUpdates() : undefined), [sample])
  const goToPage = (next: NavPage) => { setFocusGoalId(undefined); setPage(next) }
  const goToGoal = (goalId: string) => { setOpenRequest(null); setFocusGoalId(goalId); setPage('goals') }

  return (
    <MotionConfig reducedMotion="user">
    <SpecOverlayContext.Provider value={showSpec}>
      <WorkspaceContext.Provider value={workspace}>
        <TooltipProvider delayDuration={150}>
          <Req ids={['R10.3', 'R10.2']} className="min-h-svh">
            <div className="min-h-svh pb-20 text-foreground md:pb-0">
              {/* Wireframe controls: not part of the product. */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 bg-card/50 px-4 py-1.5 text-xs whitespace-nowrap md:px-6">
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
              </div>

              <header className="sticky top-0 z-30 border-b border-border/70 bg-card/85 backdrop-blur-md">
                <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 md:px-6">
                  <Req ids={['R10.4']}>
                    <span className="flex items-center gap-2">
                      <CmemMark className="size-8 text-[#D86441]" />
                      <span className="sr-only md:not-sr-only md:text-[0.95rem] md:font-semibold md:tracking-tight">claude-mem</span>
                    </span>
                  </Req>
                  <h1 className="text-lg font-semibold tracking-tight md:hidden">{PAGES.find((entry) => entry.id === page)!.label}</h1>
                  <div className="ml-auto flex items-center gap-0.5 md:gap-2">
                    <TeamSwitch team={workspace.team} onChange={(team) => setWorkspace({ ...workspace, team })} />
                    <DeviceFreshness />
                    <LiveIndicator />
                    <ClassicViewerLink />
                    <GitHubStars />
                  </div>
                </div>
              </header>

              <div className="mx-auto max-w-[1440px] gap-6 px-4 py-4 md:grid md:grid-cols-[52px_minmax(0,1fr)] md:px-6 md:py-6 lg:grid-cols-[168px_minmax(0,1fr)] lg:gap-8">
                <Req ids={['R14.1', 'R3.1']} className="hidden md:block">
                  <nav aria-label="Pages" className="sticky top-20 hidden space-y-5 md:block">
                    {NAV_SECTIONS.map((section) => (
                      <div key={section} className="space-y-0.5">
                        <p className="section-label hidden px-2 pb-1 lg:block">{section}</p>
                        {PAGES.filter((entry) => entry.section === section).map(({ id, label, icon }) => (
                          <button key={id} type="button" onClick={() => goToPage(id)} aria-current={page === id ? 'page' : undefined} title={label} className={cn('relative flex h-10 w-full items-center gap-2.5 rounded-[10px] px-1.5 text-left text-[0.9rem] transition-colors', page === id ? 'bg-accent font-medium text-accent-foreground' : 'text-foreground/85 hover:bg-card/70')}>
                            <NavTile icon={icon} active={page === id} />
                            <span className="hidden lg:inline">{label}</span>
                            {id === 'work' && yourMoveCount > 0 && <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground lg:static lg:ml-auto lg:h-5 lg:min-w-5 lg:text-[11px]" aria-label={`${yourMoveCount} need you`}>{yourMoveCount}</span>}
                          </button>
                        ))}
                      </div>
                    ))}
                  </nav>
                </Req>

                <main className="min-w-0">
                  {page === 'work' && <MyWork onOpen={setOpenRequest} onOpenGoal={goToGoal} onOpenRules={() => goToPage('rules')} />}
                  {page === 'goals' && <MyGoals onOpen={setOpenRequest} focusGoalId={focusGoalId} />}
                  {page === 'rules' && <MyRules />}
                </main>
              </div>

              <Req ids={['R11.1', 'R14.1']} className="md:hidden">
                <nav aria-label="Pages" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-border/70 bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden">
                  {PAGES.map(({ id, label, icon }) => (
                    <button key={id} type="button" onClick={() => goToPage(id)} aria-current={page === id ? 'page' : undefined} className={cn('relative flex h-[68px] flex-col items-center justify-center gap-1 text-[11px]', page === id ? 'font-semibold text-accent-foreground' : 'text-muted-foreground')}>
                      <NavTile icon={icon} active={page === id} />{label}
                      {id === 'work' && yourMoveCount > 0 && <span className="absolute top-2 left-[calc(50%+6px)] flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">{yourMoveCount}</span>}
                    </button>
                  ))}
                </nav>
              </Req>

              <RequestDetail request={liveOpenRequest} onClose={() => setOpenRequest(null)} onOpenGoal={goToGoal} />
            </div>
          </Req>
        </TooltipProvider>
      </WorkspaceContext.Provider>
    </SpecOverlayContext.Provider>
    </MotionConfig>
  )
}
