// Places on the home page with an address of their own (A page-02 `deep-linking`; Phase 2 area decisions): the rail's
// My Work and the bottom bar's My Work go to every request, and "All N" in the rail and the chip row and the bottom
// bar's Focus go to the focus area board with every area shown. No new route: the address is `/#<anchor>`.

/** The one definition. Each value is also the id of the element it scrolls to (pages/my-work.tsx). */
export const HOME_ANCHORS = ['focus-areas', 'all-requests'] as const
export type HomeAnchor = (typeof HOME_ANCHORS)[number]

/** The anchor a URL fragment names, or null for none or any other fragment. */
export function homeAnchorFromHash(hash: string): HomeAnchor | null {
  const id = hash.startsWith('#') ? hash.slice(1) : hash
  return HOME_ANCHORS.find((anchor) => anchor === id) ?? null
}
