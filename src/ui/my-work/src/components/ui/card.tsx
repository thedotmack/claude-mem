import * as React from "react"
import { cn } from "@/lib/utils"

/*
 * The edge is the control edge at the strength the review's card mockup shows (G13; after/c-ui-card.png samples
 * #5a4e42 over the card fill, 55% of --control-edge), so a card reads without its shadow. `interactive` makes the
 * whole card a Tab stop that opens on click, Enter or Space, with the hand cursor, a brighter edge on hover (the
 * mockup's hover edge is the full control edge) and the shared focus ring (D b5 M115). The caller names it (role,
 * aria-label). CardFooter sits on the bottom edge, so cards stretched to one row height end level (M116).
 */
function Card({
  className,
  size = "default",
  interactive = false,
  tabIndex,
  onKeyDown,
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm"; interactive?: boolean }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      data-interactive={interactive || undefined}
      tabIndex={interactive ? (tabIndex ?? 0) : tabIndex}
      onKeyDown={interactive ? (event) => {
        onKeyDown?.(event)
        // Only the card's own key presses: Enter on a button inside it belongs to that button.
        if (event.defaultPrevented || event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return
        event.preventDefault()
        event.currentTarget.click()
      } : onKeyDown}
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl border border-control-edge/55 bg-card py-(--card-spacing) text-sm text-card-foreground shadow-panel [--card-spacing:--spacing(5)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(4)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl data-interactive:cursor-pointer data-interactive:outline-none data-interactive:transition-colors data-interactive:hover:border-control-edge data-interactive:hover:bg-surface data-interactive:focus-visible:border-ring data-interactive:focus-visible:ring-3 data-interactive:focus-visible:ring-ring/50",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "mt-auto flex items-center rounded-b-xl border-t bg-surface/70 p-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
