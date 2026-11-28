import * as React from "react"
import { cn } from "@/lib/utils"
import { Dialog as SheetPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n"
import { XIcon } from "lucide-react"
import { useReturnFocusToOpener } from "./interaction-behavior"

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

/**
 * Dims the page and does not blur it (D b17 M 354): the work behind stays readable while the person replies. The dim
 * is the --overlay-dim token (index.css), stronger in dark mode.
 */
function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-overlay-dim duration-100 motion-safe:data-open:animate-in data-open:fade-in-0 motion-safe:data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * A side panel. One width for every side panel (D b17 M 355: the drawer and the build story were 612 and 544px), set
 * here and nowhere else: `max-w-xl`, 612px at the 17px desktop root. A --control-edge hairline on the panel edge
 * (M 354). The panel is the scroll container (`overflow-y-auto`): SheetHeader and SheetFooter stay put while the
 * middle scrolls (M 352), and the 44px close button (M 353) stays at the top right. The close is last in the DOM, so
 * Tab order is unchanged, and drawn first. Children sit with no gap, so the zero-height close row adds no space;
 * a caller spaces its own parts.
 *
 * Focus starts on the panel itself, not on its first control: the reader hears the panel's title, the first Tab goes
 * to the first control, and a control's tooltip cannot open over the title when the panel opens from a link, a reload
 * or a key (the Phase 1 verifier saw the agent tooltip cover the drawer's title, and the first Escape close only that
 * tooltip). A caller that prevents the default of `onOpenAutoFocus` places focus itself. Focus returns to whatever
 * opened the panel (F 344).
 */
function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
}) {
  const { t } = useI18n()
  const focusReturn = useReturnFocusToOpener({ onOpenAutoFocus, onCloseAutoFocus })
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        onOpenAutoFocus={(event) => {
          focusReturn.onOpenAutoFocus(event)
          if (event.defaultPrevented) return
          event.preventDefault()
          // Radix sends this event to the panel, which it makes focusable (tabindex -1) for this purpose.
          if (event.target instanceof HTMLElement) event.target.focus({ preventScroll: true })
        }}
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        className={cn(
          "fixed z-50 flex flex-col overflow-y-auto border-control-edge bg-card bg-clip-padding text-sm text-popover-foreground shadow-popover outline-none duration-200 ease-in-out motion-safe:transition data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-full data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-full data-[side=right]:border-l data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=left]:sm:max-w-xl data-[side=right]:sm:max-w-xl motion-safe:data-open:animate-in data-open:fade-in-0 data-[side=bottom]:data-open:slide-in-from-bottom-10 data-[side=left]:data-open:slide-in-from-left-10 data-[side=right]:data-open:slide-in-from-right-10 data-[side=top]:data-open:slide-in-from-top-10 motion-safe:data-closed:animate-out data-closed:fade-out-0 data-[side=bottom]:data-closed:slide-out-to-bottom-10 data-[side=left]:data-closed:slide-out-to-left-10 data-[side=right]:data-closed:slide-out-to-right-10 data-[side=top]:data-closed:slide-out-to-top-10",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          // A zero-height row that sticks to the top of the scrolling panel, so the close button stays in view.
          <div data-slot="sheet-close-row" className="pointer-events-none sticky top-0 z-30 order-first h-0">
            <SheetPrimitive.Close data-slot="sheet-close" asChild>
              <Button
                variant="outline"
                className="pointer-events-auto absolute top-2 right-2"
                size="icon"
              >
                <XIcon
                />
                <span className="sr-only">{t('Close')}</span>
              </Button>
            </SheetPrimitive.Close>
          </div>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}

/** Stays at the top while the panel scrolls (D b17 M 352). */
function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("sticky top-0 z-10 flex flex-col gap-1 bg-card p-6", className)}
      {...props}
    />
  )
}

/** Stays at the bottom while the panel scrolls (D b17 M 352), and sits at the bottom when the content is short. */
function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("sticky bottom-0 z-10 mt-auto flex flex-col gap-2 border-t bg-card p-6", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "font-heading text-lg font-semibold tracking-tight text-foreground",
        className
      )}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
