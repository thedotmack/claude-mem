"use client"

import * as React from "react"
import { cn } from "cn"
import { Tooltip as TooltipPrimitive } from "radix-ui"
import { useControllableState } from "@radix-ui/react-use-controllable-state"
import { TRIGGER_FOCUS_RING_CLASS_NAME, useFloatingTrigger } from "./interaction-behavior"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

/**
 * The tooltip's open state, shared with its trigger so a tap can toggle it, and with its content, which waits a frame
 * after opening. `ignoreOpenFromThisEvent` keeps the tooltip closed for the event being handled (a focus that did not
 * come from the keyboard): Radix opens on focus inside that same handler, and the flag is gone once the event is done.
 * The trigger never prevents the focus event's default, so a roving-focus item it wraps still tracks its Tab stop.
 */
const TooltipOpenStateContext = React.createContext<{
  open: boolean
  setOpen: (open: boolean) => void
  ignoreOpenFromThisEvent: () => void
} | null>(null)

function Tooltip({
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
    caller: "Tooltip",
  })
  const ignoringOpenRef = React.useRef(false)
  const requestOpenChange = React.useCallback((nextOpen: boolean) => {
    if (nextOpen && ignoringOpenRef.current) return
    setOpen(nextOpen)
  }, [setOpen])
  const ignoreOpenFromThisEvent = React.useCallback(() => {
    ignoringOpenRef.current = true
    queueMicrotask(() => { ignoringOpenRef.current = false })
  }, [])
  const openState = React.useMemo(() => ({ open, setOpen, ignoreOpenFromThisEvent }), [open, setOpen, ignoreOpenFromThisEvent])
  return (
    <TooltipOpenStateContext.Provider value={openState}>
      <TooltipPrimitive.Root data-slot="tooltip" open={open} onOpenChange={requestOpenChange} {...props} />
    </TooltipOpenStateContext.Provider>
  )
}

/**
 * Every trigger takes keyboard focus and opens on it (G10, D b24: 22 of 24 triggers were unfocusable spans). A tap on
 * a trigger that does nothing else on its own toggles the tooltip, so the words are reachable on touch (D b24 F 491).
 * Focus after a click or a dialog's first focus does not open it; only keyboard focus does (useFloatingTrigger).
 */
function TooltipTrigger({
  className,
  ref,
  tabIndex,
  onFocus,
  onPointerDown,
  onClick,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const openState = React.useContext(TooltipOpenStateContext)
  if (!openState) throw new Error("TooltipTrigger must be inside a Tooltip")
  const trigger = useFloatingTrigger(openState.open, openState.setOpen, openState.ignoreOpenFromThisEvent, {
    ref, tabIndex, onFocus, onPointerDown, onClick,
  })
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      className={cn(TRIGGER_FOCUS_RING_CLASS_NAME, className)}
      {...trigger}
      {...props}
    />
  )
}

/**
 * The bubble. It appears one animation frame after the tooltip opens: a keyboard focus that scrolls its trigger into
 * view gets that scroll event at the next frame, and Radix closes an open tooltip on any scroll around its trigger,
 * listening from the moment the bubble mounts (the Phase 1 verifier's trace: open, then closed 12–16 ms later). A
 * bubble that mounts after that event stays open; a later scroll by the person still closes it.
 */
function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const open = React.useContext(TooltipOpenStateContext)?.open ?? false
  const [openedFrameDone, setOpenedFrameDone] = React.useState(false)
  // Closed: the next opening waits its frame again (set while rendering, React's way to follow a prop).
  if (!open && openedFrameDone) setOpenedFrameDone(false)
  React.useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => setOpenedFrameDone(true))
    return () => cancelAnimationFrame(frame)
  }, [open])
  // Closed, Radix plays the exit and unmounts the bubble itself.
  if (open && !openedFrameDone) return null
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-xs text-background shadow-popover has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm motion-safe:data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 motion-safe:data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-safe:data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
