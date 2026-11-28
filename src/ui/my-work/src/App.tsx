import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { MotionConfig } from 'motion/react'
import { FlaskConicalIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { useAppliedTheme } from '@/lib/use-applied-theme'
import { PAGE_FRAME } from '@/lib/page-frame'
import { runScrollAsk } from '@/lib/scroll-ask'
import { Button } from '@/components/ui/button'
import { RequestDrawerLoading, RequestDrawerSheet } from '@/components/request-drawer'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ReadAfterSaveNotice } from '@/components/bits'
import { pageHeading } from '@/components/app-bar'
import { ShellFrame, ShellLoading, ShellReadError } from '@/components/app-shell'
import { PageCrumb } from '@/components/page-crumb'
import { ReviewFailedLine } from '@/components/review-failed-line'
import { CloudTrialBanner } from '@/components/cloud-trial-banner'
import { WorkViewOfferBanner } from '@/components/work-view-offer-banner'
import { CloudTrialGuide } from '@/components/cloud-trial-guide'
import { sharedViewerOwner } from '@/live/shared-viewer-session'
import { useCloudTrial } from '@/live/use-cloud-trial'
import { StickyBanner } from '@/components/aceternity/sticky-banner'
import { MyWork } from '@/pages/my-work'
import { Req } from '@/spec/req'
import { Spinner } from '@/components/ui/spinner'
import { OTHER_FOCUS_AREA_ID } from '@/data'
import { ACTIVE_SOURCE, useStore, useWorkModel, useWorkspace, type Section } from '@/store'
import { shownFocusAreaId, themeChoiceInUse } from '@/store/slices/view-slice'
import { focusSharesAreADemonstration, useFocusSharesLoader } from '@/live/focus-shares'
import { isServedFromCloud } from '@/live/served-from'
import { useWorkViewOffer } from '@/live/use-work-view-offer'
import { cloudSyncConfiguredIn } from '@/live/work-view-offers'
import { MediaSourceContext } from '@/components/observation-media/ObsMedia'
import { SAMPLE_MEDIA_SOURCE } from '@/components/observation-media/sample-media'
import { workerMediaSource } from '@/components/observation-media/worker-media-source'

const SetupPage = lazy(() => import('@/setup/setup-page'))
const MyRules = lazy(() => import('@/pages/my-rules').then(module => ({ default: module.MyRules })))
const ReviewStack = lazy(() => import('@/pages/review-stack'))
const SuggestedAreas = lazy(() => import('@/pages/suggested-areas').then(module => ({ default: module.SuggestedAreas })))
const PastFocus = lazy(() => import('@/pages/past-focus').then(module => ({ default: module.PastFocus })))
const FindWork = lazy(() => import('@/pages/find-work').then(module => ({ default: module.FindWork })))
const Workspace = lazy(() => import('@/pages/workspace').then(module => ({ default: module.Workspace })))
const MachineAndSync = lazy(() => import('@/pages/machine-sync').then(module => ({ default: module.MachineAndSync })))
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
  const section = useStore((state) => state.view.section)
  const startWorkSource = useStore.use.startWorkSource()
  const retryWorkRead = useStore.use.retryWorkRead()
  // "Try again" leaves the page with the failed screen, so the screen that answers the retry takes focus: the next
  // failed screen's Try again, or the loaded page's main content. Without it focus fell to the page body (WCAG 2.4.3).
  const [retried, setRetried] = useState(false)
  useEffect(() => startWorkSource(ACTIVE_SOURCE), [startWorkSource])
  if (load.state === 'loaded') return <LoadedApp focusMainOnMount={retried} />
  if (section === 'workspace') return <WorkspaceBeforeLoad />
  if (load.state === 'loading') return <ShellLoading />
  return <ShellReadError cause={load.error} focusRetry={retried} onRetry={() => { setRetried(true); void retryWorkRead() }} />
}

/**
 * Workspace before the work has loaded, or while it cannot be read: it reads no work (theme, language, Memory's own
 * pages, help), so "…" opens it on the loading and failed screens too, and the person can still change the theme or
 * the language and reach Memory while the worker does not answer. Any other page goes back to the screen it waits on.
 */
function WorkspaceBeforeLoad() {
  const { t } = useI18n()
  const heading = pageHeading('workspace', t)
  return (
    <ShellFrame heading={heading} compact={PAGE_FRAME.workspace.compact}>
      <Suspense fallback={<PageLoading label={heading} />}><Workspace /></Suspense>
    </ShellFrame>
  )
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
  // The Cloud Sync and hosted offers are for this computer's own Work View, never the cloud viewer or the sample.
  // Whether Cloud Sync runs comes from the live feed the page already reads, so the offer asks the worker no more for it.
  const cloudSyncConfigured = useStore((state) => cloudSyncConfiguredIn(state.work.connection?.sync))
  const workViewOffer = useWorkViewOffer(sourceKind === 'local' && !isServedFromCloud(window.location.hostname), cloudSyncConfigured)
  const view = useStore((state) => state.view.section)
  const focusChoice = useStore((state) => state.view.focusChoice)
  const openRequest = useStore((state) => state.view.openRequest)
  const scrollAsk = useStore((state) => state.view.scrollAsk)
  const workspace = useWorkspace()
  const { goToPage, goToFocus, openRequestDrawer, closeRequestDrawer, setWorkspace, playSampleDemo } = useStore.getState()
  const focusAreaId = shownFocusAreaId({ section: 'work', focusChoice }, focusAreas)
  // The drawer always shows the current record of today's requests; an older goal-only request shows as it was passed.
  const liveOpenRequest = openRequest ? requests.find((request) => request.id === openRequest.id) ?? (openRequest.fromLiveFeed === false ? openRequest.fallback : null) : null
  // The demo flip is sample data; it never runs against real requests.
  useEffect(() => (sample ? playSampleDemo() : undefined), [sample, playSampleDemo])
  // Each move's scroll, once its page has drawn: a new page from its top, Back and Forward where the person left it
  // (once the page is tall enough to reach it). The next move's ask stops a wait that is still on.
  useLayoutEffect(() => scrollAsk ? runScrollAsk(scrollAsk.target) : undefined, [scrollAsk])
  const onHome = view === 'work' && !focusAreaId
  // A focus area's page is named by its area; its own header shows the name, so the h1 is for screen readers there.
  const areaName = focusAreaId === OTHER_FOCUS_AREA_ID ? t('Other') : focusAreas.find((area) => area.id === focusAreaId)?.name
  const heading = view === 'work' && focusAreaId ? areaName ?? pageHeading('focus', t) : pageHeading(view, t)
  const frame = PAGE_FRAME[view]
  const home = <MyWork focusAreaId={view === 'work' ? focusAreaId : null} onOpen={openRequestDrawer} onReply={(request) => openRequestDrawer(request, { reply: true })} onOpenFocus={goToFocus} onOpenRules={() => goToPage('rules')} />
  // What each page shows. Requests and Focus areas open the home page at their boards, and Build story opens it, until
  // the design pass builds them (phases 5 and 7). The same element at the same place, so moving between those keeps the
  // home page's own state.
  const page: Record<Section, () => ReactNode> = {
    work: () => home,
    focus: () => home,
    requests: () => home,
    'build-story': () => home,
    workspace: () => <Workspace />,
    machine: () => <MachineAndSync />,
    find: () => <FindWork />,
    suggested: () => <SuggestedAreas onOpenFocus={goToFocus} />,
    'past-focus': () => <PastFocus onOpenFocus={goToFocus} />,
    rules: () => <MyRules />,
    'review-stack': () => sample
      ? <Button asChild variant="outline"><a href={ownDataHref()}>{t('Open my Review Stack')}</a></Button>
      : <ReviewStack />,
  }

  const above = (
    <>
      {owner && trial.trialEndsAt && <CloudTrialBanner owner={owner} trialEndsAt={trial.trialEndsAt} />}
      {workViewOffer.offer && <WorkViewOfferBanner offer={workViewOffer.offer} onDismiss={workViewOffer.dismiss} onViewPlans={workViewOffer.viewPlans} />}
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
    </>
  )

  return (
    <MotionConfig reducedMotion="user">
      {/* Images come from the worker (this machine's, or the hosted one behind work.cmem.ai); sample mode draws fixtures. */}
      <MediaSourceContext.Provider value={sample ? SAMPLE_MEDIA_SOURCE : workerMediaSource}>
        <TooltipProvider delayDuration={150}>
          {/* R8.1: My Work at the worker's own address, read from this computer's worker and its live feed. */}
          <Req ids={['R10.3', 'R10.2', 'R8.1']} className="min-h-svh">
            <ShellFrame above={above} heading={heading} headingHidden={view === 'work' && focusAreaId !== null} mainRef={mainRef}
              compact={frame.compact} aboveHeading={frame.crumb && <PageCrumb to={frame.crumb} />}
              belowHeading={frame.reviewLine && !(view === 'work' && focusAreaId) && <ReviewFailedLine />}
              below={
                // Always mounted: its code loads after first paint, and closing keeps the loaded detail for a reopen.
                <Suspense fallback={liveOpenRequest ? <RequestDetailLoading title={liveOpenRequest.title ?? liveOpenRequest.resolvesTo?.title ?? t('Untitled request')} onClose={closeRequestDrawer} /> : null}>
                  <RequestDetail request={liveOpenRequest} onClose={closeRequestDrawer} onOpenFocus={goToFocus} />
                </Suspense>
              }>
              {onHome && trial.onboarding && <CloudTrialGuide key={trial.onboarding.startedAt} startedAt={trial.onboarding.startedAt} />}
              {/* A save whose follow-up read failed, on whichever page made it (store work.readAfterSaveFailure). */}
              <ReadAfterSaveNotice />
              <Suspense fallback={<PageLoading label={heading} />}>{page[view]()}</Suspense>
            </ShellFrame>
          </Req>
        </TooltipProvider>
      </MediaSourceContext.Provider>
    </MotionConfig>
  )
}
