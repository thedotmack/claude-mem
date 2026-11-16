"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { CheckIcon } from "lucide-react"
import { Toggle as TogglePrimitive } from "radix-ui"

/*
 * The chosen look lives here, so every toggle group item gets it (D b22 M462, b23): fill, a bright edge
 * (--muted-foreground, ≥4.5:1 on the page), heavier text and a check mark (ToggleItemContent), with no orange, so a
 * chosen filter never reads as a primary button. Choosing an item never changes its width, or the row would shift
 * on every switch. So the heavier text is a 0.5px text stroke on the same weight, not font-semibold: Geist's
 * semibold glyphs are wider (a label grew 0.8–1.4px), and a stroke changes no width. Side by side at 1x and 3x, in
 * both themes, 0.5px reads closest to semibold at these 13–15px sizes. An unchosen outline item has the ≥3:1
 * control edge (F455). `sm` and `default` keep their look with a 44×44 hit area (F477); on touch every size renders
 * ≥44px (touch-target-size). Sizes carry no min-width: a plain min-w utility would beat the touch rule, and the
 * padding already makes an icon-only item as wide as the old minimum. Disabled keeps pointer events so the
 * not-allowed cursor shows (G16). --toggle-check is the check's size: the size-4 / size-3.5 other icons get.
 */
const toggleVariants = cva(
  "group/toggle relative isolate inline-flex cursor-pointer items-center justify-center gap-1 rounded-lg border border-transparent text-sm font-medium whitespace-nowrap transition-all outline-none touch-target-size text-muted-foreground [--toggle-check:--spacing(4)] hover-enabled:bg-muted hover-enabled:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=on]:border-muted-foreground data-[state=on]:bg-muted data-[state=on]:text-foreground data-[state=on]:[-webkit-text-stroke-width:0.5px] dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "rounded-full border-control-edge bg-transparent hover-enabled:bg-card data-[state=on]:border-muted-foreground data-[state=on]:bg-muted data-[state=on]:hover-enabled:bg-muted",
      },
      size: {
        default:
          "h-10 px-3.5 expanded-hit-area has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-8 rounded-[9px] px-3 text-[0.82rem] expanded-hit-area has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [--toggle-check:--spacing(3.5)] [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 px-4 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * A toggle item's inside: the check mark a chosen item shows before its words, so "chosen" is not told by colour alone
 * (M462), then the caller's children, then a balance. The check's room is kept in both states, so choosing an item
 * does not widen it. Not chosen, the room is split in half, one half under the hidden check and one in the balance,
 * which centres the words; chosen, the check takes the whole room and the balance none. Both stay in the row in both
 * states, so the row has the same number of gaps either way, whatever gap a caller sets.
 * The check sits above anything a caller draws inside the item (the View switcher's sliding pill is absolute and would
 * paint over it); the item is its own stacking layer (`isolate`), so this reaches no further than the item.
 */
function ToggleItemContent({ children }: { children?: React.ReactNode }) {
  return (
    <>
      <CheckIcon data-slot="toggle-check" aria-hidden="true" className="invisible relative z-1 size-(--toggle-check) group-data-[state=off]/toggle:w-[calc(var(--toggle-check)/2)] group-data-[state=on]/toggle:visible" />
      {children}
      <span data-slot="toggle-check-balance" aria-hidden="true" className="w-[calc(var(--toggle-check)/2)] shrink-0 group-data-[state=on]/toggle:w-0" />
    </>
  )
}

function Toggle({
  className,
  variant = "default",
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    >
      <ToggleItemContent>{children}</ToggleItemContent>
    </TogglePrimitive.Root>
  )
}

export { Toggle, ToggleItemContent, toggleVariants }
