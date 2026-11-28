"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

/** Whether the viewport's content is taller or wider than the viewport, kept current as either one resizes. */
function useContentOverflows(viewportRef: React.RefObject<HTMLDivElement | null>) {
  const [contentOverflows, setContentOverflows] = React.useState(false)
  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    // scrollHeight and scrollWidth are whole pixels while clientHeight can round down: 1px absorbs that rounding.
    const measure = () => setContentOverflows(
      viewport.scrollHeight > viewport.clientHeight + 1 || viewport.scrollWidth > viewport.clientWidth + 1
    )
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild)
    return () => observer.disconnect()
  }, [viewportRef])
  return contentOverflows
}

/**
 * A short list is a plain list; a long one scrolls inside a box (D b15). The area measures itself: while its content
 * fits there is no box, no scrollbar and no Tab stop (M 311). Once it overflows it draws a --control-edge box, keeps
 * its thumb visible, takes keyboard focus so it scrolls from the keyboard, and shows `overflowCaption` under it, such
 * as "6 of 37 shown" (M 312). Limit the height with a max-h-* class on the area; the viewport inherits it.
 * `scrollRegionLabel` names the scrolling region for screen readers.
 */
function ScrollArea({
  className,
  children,
  type = "auto",
  scrollRegionLabel,
  overflowCaption,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  scrollRegionLabel?: string
  overflowCaption?: React.ReactNode
}) {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const contentOverflows = useContentOverflows(viewportRef)
  return (
    <>
      <ScrollAreaPrimitive.Root
        data-slot="scroll-area"
        data-overflowing={contentOverflows || undefined}
        type={type}
        className={cn("relative data-overflowing:rounded-lg data-overflowing:border data-overflowing:border-control-edge", className)}
        {...props}
      >
        <ScrollAreaPrimitive.Viewport
          ref={viewportRef}
          data-slot="scroll-area-viewport"
          tabIndex={contentOverflows ? 0 : undefined}
          role={contentOverflows && scrollRegionLabel ? "region" : undefined}
          aria-label={contentOverflows ? scrollRegionLabel : undefined}
          className="size-full max-h-[inherit] rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-solid focus-visible:outline-ring"
        >
          {children}
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar />
        <ScrollAreaPrimitive.Corner />
      </ScrollAreaPrimitive.Root>
      {contentOverflows && overflowCaption !== undefined && overflowCaption !== null && (
        <p data-slot="scroll-area-caption" className="mt-1.5 text-xs text-muted-foreground tabular">{overflowCaption}</p>
      )}
    </>
  )
}

/** The thumb is --control-edge, so a scrolling list shows it scrolls (D b15 M 312: a visible thumb). */
function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-control-edge"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
