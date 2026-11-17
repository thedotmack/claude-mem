// The request drawer's frame (page-05, D b17): one Sheet for its loading, failed and loaded states, so the open panel and
// the focus inside it stay put while the detail arrives, and focus goes back to whatever opened the drawer when it
// closes (F 344). The loading screen App.tsx shows while the drawer's own code arrives uses it too, so this file is in
// the main bundle and components/request-detail.tsx (loaded later) shares it.
import type { ReactNode } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { focusReturnFallback, focusReturnTarget } from '@/components/ui/interaction-behavior'
import { t, useI18n } from '@/lib/i18n'
import { useStore } from '@/store'

/**
 * What opened the request drawer: the element focused as the drawer's first frame opened (a card's title, its Reply, a
 * list row, or for a menu item what opened its menu: the one focus-return rule, ui/interaction-behavior.ts
 * focusReturnTarget), with the request it opened and whether it sat on the board. The drawer can open in two frames
 * (App.tsx's loading screen while the drawer's code arrives, then the drawer), and the second sees focus on the page
 * body, so the opener is kept here for the whole time it is open. Each Sheet keeps its own opener otherwise
 * (useReturnFocusToOpener), which loses it here.
 */
let drawerOpener: { element: HTMLElement; requestId: string | null; inBoard: boolean } | null = null

function rememberDrawerOpener() {
  const element = focusReturnTarget(document.activeElement)
  if (!element || element.closest('[data-slot="sheet-content"]')) return
  drawerOpener = { element, requestId: useStore.getState().view.openRequest?.id ?? null, inBoard: element.closest('[data-board-view]') !== null }
}

/**
 * Called as a frame of the drawer leaves the page. While a request is still open (the store's `view.openRequest`), the
 * frame gave way to the drawer's next one and focus stays inside it; once none is, the drawer has closed (Close,
 * Escape, Back) and focus goes back to its opener. When that opener left the page while the drawer was open (the List
 * draws each state group apart, so a request that changed state is drawn again under its new group), focus goes to
 * the same request's row in its new place, else to the view's heading, never the page body (phase-4 quality finding 1).
 */
function returnFocusWhenTheDrawerCloses(event: Event) {
  event.preventDefault()
  if (useStore.getState().view.openRequest) return
  const opener = drawerOpener
  drawerOpener = null
  if (!opener) return
  const target = opener.element.isConnected ? opener.element : focusReturnFallback(opener)
  target?.focus()
}

/** The drawer's Sheet. `onEscapeKeyDown` lets the drawer keep itself open while its image viewer takes Escape. */
export function RequestDrawerSheet({ onClose, onEscapeKeyDown, children }: { onClose: () => void; onEscapeKeyDown?: (event: KeyboardEvent) => void; children: ReactNode }) {
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent onEscapeKeyDown={onEscapeKeyDown} onOpenAutoFocus={rememberDrawerOpener} onCloseAutoFocus={returnFocusWhenTheDrawerCloses}>
        {children}
      </SheetContent>
    </Sheet>
  )
}

/**
 * The drawer while its detail loads (D b18 M 373: a wait shows the page's shape, not a lone ring): the request's title
 * and summary as the card had them, the words said once, and the shapes of the progress line, the reply card and the
 * five folds. The shapes are hidden from screen readers; the status line says it is loading. Rule 8 (at most two moving
 * things a view) counts the seven shapes as one: they mount in one frame and pulse in step, one animation drawn seven
 * times, and only when motion is allowed (Skeleton: motion-safe:animate-pulse).
 */
export function RequestDrawerLoading({ title, summary }: { title: string; summary?: string | null }) {
  useI18n()
  return (
    <>
      <SheetHeader className="gap-3 border-b p-5 pr-14 md:p-6 md:pr-14">
        <SheetTitle className="text-xl leading-snug">{title}</SheetTitle>
        <SheetDescription>{summary ?? t('Request details')}</SheetDescription>
      </SheetHeader>
      <div aria-busy="true" className="space-y-4 p-5 md:p-6">
        <p role="status" className="text-sm text-muted-foreground">{t('Loading request detail…')}</p>
        <Skeleton className="h-2 w-full rounded-full" />
        <Skeleton className="h-36 w-full rounded-xl" />
        <div className="space-y-2">
          {/* One shape per fold the drawer draws (Deliverables, Workstreams, Build story, Latest records, Where this came from). */}
          {[0, 1, 2, 3, 4].map((fold) => <Skeleton key={fold} className="h-11 w-full rounded-lg" />)}
        </div>
      </div>
    </>
  )
}
