import * as React from "react"

/*
 * Behaviour shared by the primitives that open floating content or overlays: Tooltip, HoverCard (decision G10) and
 * Dialog, Sheet (D b8, b17). Plain functions and hooks; each primitive composes them onto its Radix parts.
 */

/**
 * The shared focus look on a trigger that is not a Button (an agent icon, a date chip): a 1px ring-colour edge plus a
 * 3px half-strength ring (contract, K 87), drawn as an outline so the trigger's layout does not move. Buttons draw the
 * same look with their own border, so they are skipped.
 */
export const TRIGGER_FOCUS_RING_CLASS_NAME =
  "[&:not(button)]:focus-visible:outline-1 [&:not(button)]:focus-visible:outline-solid [&:not(button)]:focus-visible:outline-ring [&:not(button)]:focus-visible:ring-3 [&:not(button)]:focus-visible:ring-ring/50"

/** Elements that already act when pressed. A tap on one keeps its own meaning instead of toggling floating content. */
const ACTIONABLE_ELEMENT_SELECTOR =
  'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [role="tab"]'

/**
 * Elements the browser already puts in the Tab order, and elements that manage their own tabindex (a roving-focus
 * item in a toggle group or a menu carries tabindex 0 or -1 itself). A trigger never adds a Tab stop to these.
 */
const FOCUSABLE_ON_ITS_OWN_SELECTOR =
  'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]:not([contenteditable="false"])'

export function isActionableElement(element: Element): boolean {
  return element.matches(ACTIONABLE_ELEMENT_SELECTOR)
}

/** The control inside `container` that a press on `target` landed in, if any (a link or button inside a table row). */
export function actionableElementInside(container: Element, target: EventTarget | null): Element | null {
  const actionable = target instanceof Element ? target.closest(ACTIONABLE_ELEMENT_SELECTOR) : null
  return actionable && actionable !== container && container.contains(actionable) ? actionable : null
}

/**
 * Keyboard focus opens floating content (G10). Focus that follows a pointer press, or the first focus a dialog moves
 * in by script after a click, does not: the browser marks only keyboard-style focus as `:focus-visible`.
 */
export function isKeyboardFocus(element: Element): boolean {
  return element.matches(":focus-visible")
}

/**
 * A tap on a trigger that does nothing else on its own toggles its floating content (G10: "toggle on tap"). The open
 * state is read at pointer-down, because a Radix trigger or an outside-press may close the content on that same
 * pointer-down, before the click arrives.
 */
export function useTapToggle(open: boolean, setOpen: (open: boolean) => void) {
  const lastPointerTypeRef = React.useRef("")
  const openAtPointerDownRef = React.useRef(false)
  return {
    recordPointerDown(event: React.PointerEvent<HTMLElement>) {
      lastPointerTypeRef.current = event.pointerType
      openAtPointerDownRef.current = open
    },
    toggleOnTap(event: React.MouseEvent<HTMLElement>) {
      if (lastPointerTypeRef.current !== "touch" || isActionableElement(event.currentTarget)) return
      // Keeps the Radix trigger from running its own close for this click.
      event.preventDefault()
      setOpen(!openAtPointerDownRef.current)
    },
  }
}

/** Sets a React ref, whichever form the caller passed. */
export function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value)
  else if (ref) ref.current = value
}

/**
 * What a Tooltip or HoverCard trigger adds to its Radix trigger (G10), in one place:
 * - a Tab stop, only when the element cannot take focus by itself (D b24 M 497, b11 M 231: the agent icons and date
 *   chips were plain spans). A button, a link or a roving-focus item keeps its own tabindex, and no tabIndex key is
 *   passed at all then (an explicit undefined would still replace the item's own), so an arrow-key group (toggle
 *   group, menu) keeps its single Tab stop;
 * - keyboard focus opens the content, as Radix does; any other focus (after a pointer press, or the first focus a
 *   dialog moves in by script) is handed to `keepClosedOnFocus`, which each primitive words for its Radix part;
 * - a tap on a trigger that does nothing else on its own toggles the content.
 * The caller's own handlers run first; one that prevents the default skips what follows it.
 */
export function useFloatingTrigger<T extends HTMLElement>(
  open: boolean,
  setOpen: (open: boolean) => void,
  keepClosedOnFocus: (event: React.FocusEvent<T>) => void,
  props: {
    ref?: React.Ref<T>
    tabIndex?: number
    onFocus?: React.FocusEventHandler<T>
    onPointerDown?: React.PointerEventHandler<T>
    onClick?: React.MouseEventHandler<T>
  }
) {
  const { ref, tabIndex, onFocus, onPointerDown, onClick } = props
  const tapToggle = useTapToggle(open, setOpen)
  const elementRef = React.useRef<T | null>(null)
  const [needsTabStop, setNeedsTabStop] = React.useState(false)
  // Measured once, before the first paint: the element is what the trigger wraps (asChild) or Radix's own default.
  React.useLayoutEffect(() => {
    const element = elementRef.current
    if (element && !element.matches(FOCUSABLE_ON_ITS_OWN_SELECTOR)) setNeedsTabStop(true)
  }, [])
  const setElement = React.useCallback((element: T | null) => {
    elementRef.current = element
    assignRef(ref, element)
  }, [ref])
  const resolvedTabIndex = tabIndex ?? (needsTabStop ? 0 : undefined)
  return {
    ref: setElement,
    ...(resolvedTabIndex === undefined ? {} : { tabIndex: resolvedTabIndex }),
    onFocus(event: React.FocusEvent<T>) {
      onFocus?.(event)
      if (!event.defaultPrevented && !isKeyboardFocus(event.currentTarget)) keepClosedOnFocus(event)
    },
    onPointerDown(event: React.PointerEvent<T>) {
      onPointerDown?.(event)
      tapToggle.recordPointerDown(event)
    },
    onClick(event: React.MouseEvent<T>) {
      onClick?.(event)
      if (!event.defaultPrevented) tapToggle.toggleOnTap(event)
    },
  }
}

/**
 * Each open menu, mapped to the element that opened it: a menu's button, or for a sub-menu its row in the parent menu
 * (dropdown-menu.tsx registers both). Radix also names a menu by its trigger's id, but a caller's own id on the trigger
 * replaces that id in the page, so the element itself is kept here.
 */
const MENU_OPENERS = new WeakMap<Element, React.RefObject<HTMLElement | null>>()

export function rememberMenuOpener(menu: Element, opener: React.RefObject<HTMLElement | null>) {
  MENU_OPENERS.set(menu, opener)
}

/**
 * The one rule for where focus goes back when something opened from the page closes: the element that had focus when
 * it opened, or for a menu item, what opened its menu. Menus nest only a few levels deep; each step of the walk below
 * climbs one, and an element seen twice ends it.
 */
export function focusReturnTarget(focused: Element | null): HTMLElement | null {
  let target = focused instanceof HTMLElement && focused !== document.body ? focused : null
  const seen = new Set<Element>()
  while (target && !seen.has(target)) {
    seen.add(target)
    // A menu item gives way to what opened its menu: the menu closes, and its items leave the page, as the dialog
    // opens (D b8: Rename, Edit goal, Merge and Share in a focus area's "…" menu dropped focus on the page body).
    const menu = target.closest('[role="menu"]')
    const opener = menu ? MENU_OPENERS.get(menu)?.current : null
    if (!opener) break
    target = opener
  }
  return target
}

/**
 * Where focus goes when the element that opened something has left the page by the time it closes: the element that
 * now opens the same thing (`[data-request-opener="<id>"]`: a request's row redrawn in another state group while its
 * drawer was open, phase-4 quality finding 1), else the view's heading (`[data-view-heading]`, focusable from code).
 * One that sits in the same board as the old one comes first. Null when the page has neither.
 */
export function focusReturnFallback(gone: { requestId: string | null; inBoard: boolean }): HTMLElement | null {
  const openers = gone.requestId === null ? [] : [...document.querySelectorAll<HTMLElement>(`[data-request-opener="${CSS.escape(gone.requestId)}"]`)]
  const sameBoard = openers.find((opener) => gone.inBoard === (opener.closest('[data-board-view]') !== null))
  return sameBoard ?? openers[0] ?? document.querySelector<HTMLElement>('[data-view-heading]')
}

/**
 * Puts focus back on whatever opened a dialog or sheet when it closes (D b8, b17: focus landed on the page body).
 * Radix returns focus only to its own Dialog.Trigger, and the app opens its dialogs from plain buttons, cards and menu
 * items. The opener is read when the dialog moves focus in, before anything inside takes it; for a menu item it is
 * the menu's trigger. The caller's own handlers run too.
 */
export function useReturnFocusToOpener(handlers: {
  onOpenAutoFocus?: (event: Event) => void
  onCloseAutoFocus?: (event: Event) => void
}) {
  const openerRef = React.useRef<HTMLElement | null>(null)
  const { onOpenAutoFocus, onCloseAutoFocus } = handlers
  return {
    onOpenAutoFocus(event: Event) {
      openerRef.current = focusReturnTarget(document.activeElement)
      onOpenAutoFocus?.(event)
    },
    onCloseAutoFocus(event: Event) {
      onCloseAutoFocus?.(event)
      const opener = openerRef.current
      openerRef.current = null
      // Gone from the page: Radix's own handler then focuses a Dialog.Trigger when there is one.
      if (event.defaultPrevented || !opener?.isConnected) return
      event.preventDefault()
      opener.focus()
    },
  }
}
