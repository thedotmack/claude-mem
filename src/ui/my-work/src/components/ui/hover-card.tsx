import * as React from "react"
import { cn } from "cn"
import { HoverCard as HoverCardPrimitive } from "radix-ui"
import { useControllableState } from "@radix-ui/react-use-controllable-state"
import { TRIGGER_FOCUS_RING_CLASS_NAME, useFloatingTrigger } from "./interaction-behavior"

/** The card's open state and its id, shared with the trigger so a tap can toggle it and the trigger can point at it. */
const HoverCardOpenStateContext = React.createContext<{
  open: boolean
  setOpen: (open: boolean) => void
  contentId: string
} | null>(null)

function HoverCard({
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
    caller: "HoverCard",
  })
  const contentId = React.useId()
  const openState = React.useMemo(() => ({ open, setOpen, contentId }), [open, setOpen, contentId])
  return (
    <HoverCardOpenStateContext.Provider value={openState}>
      <HoverCardPrimitive.Root data-slot="hover-card" open={open} onOpenChange={setOpen} {...props} />
    </HoverCardOpenStateContext.Provider>
  )
}

function keepHoverCardClosed(event: React.FocusEvent<HTMLAnchorElement>) {
  event.preventDefault()
}

/**
 * Opens on hover, on keyboard focus and on tap (G10, D b11: 0 of 47 date chips opened by keyboard or touch). The
 * trigger is a Tab stop and points at the open card with aria-describedby (D b11 F 226). It does not say
 * aria-expanded: pressing a hover card's trigger never opens the card (a button trigger keeps its own action, such as
 * Team switching the view), so "expanded" would describe something the press does not do.
 */
function HoverCardTrigger({
  className,
  ref,
  tabIndex,
  onFocus,
  onPointerDown,
  onClick,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  const openState = React.useContext(HoverCardOpenStateContext)
  if (!openState) throw new Error("HoverCardTrigger must be inside a HoverCard")
  // Radix opens a hover card on a timer after any focus, so only skipping its focus handler keeps one closed.
  const trigger = useFloatingTrigger(openState.open, openState.setOpen, keepHoverCardClosed, {
    ref, tabIndex, onFocus, onPointerDown, onClick,
  })
  return (
    <HoverCardPrimitive.Trigger
      data-slot="hover-card-trigger"
      aria-describedby={openState.open ? openState.contentId : undefined}
      className={cn(TRIGGER_FOCUS_RING_CLASS_NAME, className)}
      {...trigger}
      {...props}
    />
  )
}

function HoverCardContent({
  className,
  align = "center",
  sideOffset = 4,
  id,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  const openState = React.useContext(HoverCardOpenStateContext)
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        // The card's own id, so the trigger's aria-describedby always finds it.
        id={openState?.contentId ?? id}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-64 origin-(--radix-hover-card-content-transform-origin) rounded-xl border border-control-edge bg-popover p-4 text-sm text-popover-foreground shadow-popover outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 motion-safe:data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-safe:data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
