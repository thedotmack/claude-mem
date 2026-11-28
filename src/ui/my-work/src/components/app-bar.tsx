// The one bar (My Work design pass, Phase 3; Codex D14, Claude D01): the brain mark and its name, My Work's places
// (src/ui/app-places.ts), then Find work, Memory and "…" (the Workspace page, Phase 4), on every page, the loading and
// failed screens included. It reads only where the person is (the store's view), never the work model or the live
// feed, so it draws before the work has loaded and while it cannot be read. Under 768px the places move to a bottom
// bar and the top keeps the mark, Find work's search mark and "…". Cmd K (Ctrl K) opens Find work from any page.
import { useEffect, type ReactNode } from 'react'
import { BookMarkedIcon, GalleryVerticalEndIcon, HouseIcon, LayersIcon, LibraryIcon, ListChecksIcon, MoreHorizontalIcon, SearchIcon, type LucideIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { underWorkspace } from '@/lib/page-frame'
import { placeLinkPress, usePageHref } from '@/lib/place-link'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { useStore, type Section } from '@/store'
import { activePlace } from '@/store/slices/view-slice'
import { MEMORY_PLACE, MY_WORK_PLACE_IDS, MY_WORK_PLACES, myWorkPlace, type MyWorkPlace, type MyWorkPlaceId } from '../../../app-places'
import type { Translate } from './bits'
import { CmemMark } from './brand'

/** Each place's mark in the phone's bottom bar (Codex's phone mockups; Review Stack keeps the mark it had). */
const PLACE_ICON: Record<MyWorkPlaceId, LucideIcon> = {
  work: HouseIcon,
  focus: LayersIcon,
  requests: ListChecksIcon,
  'review-stack': GalleryVerticalEndIcon,
  rules: BookMarkedIcon,
}

/**
 * The h1 of each page that is not one of the bar's places (a place's page is headed by the place's own words,
 * src/ui/app-places.ts). Until the design pass builds it, Build story opens My Work's home page (Phase 7), so it is
 * headed My Work.
 */
const OTHER_PAGE_HEADING: Record<Exclude<Section, MyWorkPlaceId>, (t: Translate) => string> = {
  suggested: (t) => t('Suggested'),
  'past-focus': (t) => t('Past focus'),
  'build-story': (t) => t(myWorkPlace('work').label),
  workspace: (t) => t('Workspace'),
  machine: (t) => t('Machine and sync'),
  find: (t) => t('Find work'),
}

/** The attribute Cmd K finds Find work's box by when Find work is already the page shown (pages/find-work.tsx). */
export const FIND_WORK_INPUT_ATTRIBUTE = 'data-find-work-input'

/** Apple's keyboards say ⌘ for the shortcut; every other says Ctrl. Read once: the keyboard does not change in a visit. */
const APPLE_KEYBOARD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

const isTextField = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit'].includes(target.type)))

/** An open dialog (Radix marks its dialogs and alert dialogs open; it sets no aria-modal, so that is not read). */
const OPEN_DIALOG_SELECTOR = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'

/** Opens Find work, or, when it is the page shown, puts the cursor back in its box and keeps its words. */
function openFindWork() {
  const { view, goToPage } = useStore.getState()
  if (view.section === 'find') document.querySelector<HTMLElement>(`[${FIND_WORK_INPUT_ATTRIBUTE}]`)?.focus()
  else goToPage('find')
}

/**
 * Cmd K or Ctrl K, from any My Work page, opens Find work, or puts the cursor in its box when it is already open.
 * The key is read by its place on the keyboard (`code`), so it works on every layout (Ctrl K on a Russian layout sends
 * "л"). On Apple keyboards Ctrl K inside a text field is the field's own command (delete to the end of the line), so
 * there it is left to the field; Cmd K always opens Find work. Nothing happens while a dialog is open (moving would
 * take the page and its unsaved edit away under it) or when something on the page already handled the key.
 */
function useFindWorkShortcut() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'KeyK' || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey)) return
      if (event.defaultPrevented || document.querySelector(OPEN_DIALOG_SELECTOR)) return
      if (APPLE_KEYBOARD && !event.metaKey && isTextField(event.target)) return
      event.preventDefault()
      openFindWork()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

const isPlaceId = (section: Section): section is MyWorkPlaceId => (MY_WORK_PLACE_IDS as readonly Section[]).includes(section)

/** The h1 of a page other than a focus area's (the loaded app names an area's page by its area). */
export const pageHeading = (section: Section, t: Translate) => isPlaceId(section) ? t(myWorkPlace(section).label) : OTHER_PAGE_HEADING[section](t)

/**
 * The h1 of the screens before the work has loaded: the page's words, and for a focus area's page Focus areas, the
 * place it sits under (its name is in the work that has not been read).
 */
export function usePageHeadingBeforeLoad(): string {
  const { t } = useI18n()
  const section = useStore((state) => state.view.section)
  const inArea = useStore((state) => state.view.section === 'work' && state.view.focusChoice !== null)
  return pageHeading(inArea ? 'focus' : section, t)
}

/**
 * One of the bar's places: a real link (a new tab, a copied link), and a plain press moves there in the page. The
 * place shown is marked by more than its colour (WCAG 1.4.1): its green tint and words, and a 2px edge along its foot
 * in the words' green, ≥3:1 on the tint and on the bar (tests/ui/my-work/token-contrast.test.ts). Every place keeps
 * the edge's room, so marking one moves nothing.
 */
function PlaceLink({ place, current, className, children }: { place: MyWorkPlace; current: boolean; className: string; children: ReactNode }) {
  const href = usePageHref(place.id)
  return (
    <a href={href} aria-current={current ? 'page' : undefined} onClick={placeLinkPress(() => useStore.getState().goToPage(place.id))}
      className={cn('touch-target-size inline-flex items-center justify-center border-b-2 border-b-transparent text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:border-b-place-active-foreground aria-[current=page]:bg-place-active aria-[current=page]:text-place-active-foreground', className)}>
      {children}
    </a>
  )
}

/** The brain mark and the product's name, the link home (Codex: on every page, at every width). */
function BrandLink() {
  const href = usePageHref('work')
  return (
    <Req ids={['R10.4']}>
      <a href={href} onClick={placeLinkPress(() => useStore.getState().goToPage('work'))}
        className="touch-target-size inline-flex shrink-0 items-center gap-2 rounded-lg text-brand-phone whitespace-nowrap text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 lg:gap-2.5 lg:text-brand">
        <CmemMark className="size-7 text-[#D86441] lg:size-8.5" />
        <span>claude-mem</span>
      </a>
    </Req>
  )
}

/**
 * Find work in the bar (Codex's `.search-short`): from 1280px a box with its name and the shortcut, narrower its search
 * mark alone in the box, which a phone shows without the box. Its words wait for 1280px, not Codex's 850px, because the
 * bar holds five places, not four: at 1024px the words ran the bar 60px past the window (measured). A real link to the
 * page; marked while Find work is shown, and pressed there it puts the cursor back in the box, as Cmd K does.
 */
function FindWorkLink() {
  const { t } = useI18n()
  const href = usePageHref('find')
  const current = useStore((state) => state.view.section === 'find')
  return (
    <a href={href} aria-label={t('Find work')} aria-current={current ? 'page' : undefined} aria-keyshortcuts="Meta+K Control+K" onClick={placeLinkPress(openFindWork)}
      className="touch-target-size inline-flex h-11 shrink-0 items-center justify-center gap-2.5 rounded-lg px-2.5 text-sm whitespace-nowrap text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 md:border md:border-border md:bg-background aria-[current=page]:bg-place-active aria-[current=page]:text-place-active-foreground md:aria-[current=page]:bg-place-active xl:gap-4 xl:pr-2.5 xl:pl-3">
      <SearchIcon aria-hidden="true" className="size-5 md:size-4.5" />
      <span className="sr-only xl:not-sr-only">{t('Find work')}</span>
      <kbd aria-hidden="true" className="hidden rounded border border-border px-1 font-terminal text-xs text-muted-foreground xl:inline">{APPLE_KEYBOARD ? '⌘ K' : 'Ctrl K'}</kbd>
    </a>
  )
}

/** "…", the Workspace page (it replaced the bar's menu): its mark alone, named for screen readers; marked on Workspace and the pages reached from it (lib/page-frame.ts). */
function WorkspaceLink() {
  const { t } = useI18n()
  const href = usePageHref('workspace')
  const current = useStore((state) => underWorkspace(state.view.section))
  return (
    <a href={href} aria-label={t('Workspace')} aria-current={current ? 'page' : undefined} onClick={placeLinkPress(() => useStore.getState().goToPage('workspace'))}
      className="touch-target-size inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:bg-place-active aria-[current=page]:text-place-active-foreground">
      <MoreHorizontalIcon aria-hidden="true" className="size-5" />
    </a>
  )
}

/**
 * The top of every page: sticky, so the places stay one press away while the page scrolls. Below 1024px the brand, the
 * places and the gaps take Codex's narrow sizes (its 850px step), and the bar's three parts sit 8px apart (Codex: 12px),
 * so all five places and Find work's mark fit from 768px up, also beside a classic 15px scrollbar (at 12px the bar ran
 * 4px past a 753px page, measured).
 */
export function AppTopBar() {
  const { t } = useI18n()
  const active = useStore((state) => activePlace(state.view))
  useFindWorkShortcut()
  return (
    <header data-slot="app-bar" className="sticky top-0 z-30 h-top-bar-phone border-b border-border bg-card md:h-top-bar">
      <div className="mx-auto flex h-full max-w-bar-content items-center gap-2 px-4.5 md:px-4 lg:gap-4 lg:px-6.5 xl:gap-7.5 xl:px-11.5">
        <BrandLink />
        <nav aria-label={t('Pages')} className="hidden items-center gap-0.5 md:flex lg:gap-1">
          {MY_WORK_PLACES.map((place) => (
            <PlaceLink key={place.id} place={place} current={place.id === active} className="h-11 rounded-lg px-2 text-place-narrow whitespace-nowrap lg:px-3 lg:text-place">
              {t(place.label)}
            </PlaceLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-0.5 md:gap-1 lg:gap-3">
          <FindWorkLink />
          <span aria-hidden="true" className="hidden h-6 w-px bg-border xl:block" />
          {/* Memory is another page; from 768px up it is in the bar (its name from 1024px), on a phone in Workspace. */}
          <a href={MEMORY_PLACE.address}
            className="touch-target-size hidden h-11 items-center gap-2 rounded-lg px-2.5 text-sm whitespace-nowrap text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 md:inline-flex">
            <LibraryIcon aria-hidden="true" className="size-4.5" />
            <span className="sr-only lg:not-sr-only">{t(MEMORY_PLACE.label)}</span>
          </a>
          <WorkspaceLink />
        </div>
      </div>
    </header>
  )
}

/** The phone's places: pinned to the bottom edge, with the safe area inside it (the page's padding ends above it). */
export function AppBottomBar() {
  const { t } = useI18n()
  const active = useStore((state) => activePlace(state.view))
  return (
    <Req ids={['R11.1']}>
      <nav aria-label={t('Pages')} data-slot="bottom-bar"
        className="fixed inset-x-0 bottom-0 z-30 grid min-h-bottom-bar grid-cols-5 gap-0.5 border-t border-border bg-card px-2 pt-1 pb-[max(var(--spacing-bottom-bar-floor),env(safe-area-inset-bottom))] md:hidden">
        {MY_WORK_PLACES.map((place) => {
          const Icon = PLACE_ICON[place.id]
          return (
            <PlaceLink key={place.id} place={place} current={place.id === active} className="min-h-11 min-w-0 flex-col gap-0.5 rounded-lg px-0.5 text-xs font-medium">
              <Icon aria-hidden="true" className="size-4.5" />
              <span className="max-w-full truncate">{t(place.shortLabel)}</span>
            </PlaceLink>
          )
        })}
      </nav>
    </Req>
  )
}
