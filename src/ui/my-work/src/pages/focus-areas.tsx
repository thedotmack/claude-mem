// Focus areas (`?view=focus`, the bar's Focus areas): the focus area board with every area shown, as the home page drew
// it before the design pass (components/focus-overview.tsx, with its "Past focus" link). Home gave the board up in
// design pass Phase 6, so it is this page's own until Phase 7 builds the page with its Current, Suggested and Past focus
// tabs. The last focus change, made here or on an area's page (Mark done takes an area off this board), shows with its
// Undo, as it did when this board was on the home page.
import { SourceReadAlert } from '@/components/bits'
import { FocusChangeBar, useFocusChanges } from '@/components/focus-changes'
import { FocusOverview } from '@/components/focus-overview'
import '@/components/focus-overview.css'
import { useStore, useWorkModel } from '@/store'

export function FocusAreasBoard() {
  const { requests, requestReadErrors, sourceHealth, focusAreas } = useWorkModel()
  const artwork = useStore((state) => state.view.focusArtwork)
  const focusChanges = useFocusChanges('focus-areas')
  // Every area shows on this page. Each press of the bar's Focus areas is a new scroll ask, so each one shows the whole
  // board again after the person folded it back.
  const allAreasAsked = useStore((state) => state.view.scrollAsk?.sequence ?? 1)
  const { goToFocus, openRequestDrawer } = useStore.getState()
  return (
    <div className="space-y-4 md:space-y-5">
      {!sourceHealth.connected && <SourceReadAlert error={sourceHealth.error} />}
      <FocusChangeBar changes={focusChanges} />
      <FocusOverview anchorId="focus-areas" expandAllOn={allAreasAsked} areas={focusAreas} requests={requests} incomplete={requestReadErrors.length > 0}
        onOpenArea={goToFocus} onOpenRequest={openRequestDrawer} artwork={artwork} />
    </div>
  )
}
