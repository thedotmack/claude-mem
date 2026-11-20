import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Loader2Icon } from "lucide-react"
import { Slot } from "radix-ui"
import { useI18n } from "@/lib/i18n"

/*
 * Sizes follow the UI UX Pro Max review's button mockup at the 16px root (sm 36px with a 44px hit area, default
 * 44px, lg 48px, icon 44px); the 17px desktop root scales them by 17/16. On touch every size renders at least
 * 44×44px through touch-target-size (plan rule 6), which the base carries so pages never add their own.
 * Disabled keeps pointer events so the not-allowed cursor shows (G16); hover and press looks use the
 * hover-enabled / active-enabled variants, which skip disabled, aria-disabled and busy buttons.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none touch-target-size focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active-enabled:not-aria-[haspopup]:not-data-[variant=bare]:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-busy:cursor-progress aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-primary-deep bg-linear-to-b from-primary-bright to-primary text-primary-foreground shadow-primary hover-enabled:from-primary hover-enabled:to-primary-deep active-enabled:from-primary-deep active-enabled:to-primary-deep active-enabled:shadow-none",
        outline:
          "border-control-edge bg-card text-foreground hover-enabled:border-muted-foreground hover-enabled:bg-surface active-enabled:border-muted-foreground active-enabled:bg-[color-mix(in_oklch,var(--surface),var(--foreground)_8%)] aria-expanded:bg-surface aria-expanded:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover-enabled:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] active-enabled:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_10%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover-enabled:bg-muted hover-enabled:text-foreground active-enabled:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_8%)] aria-expanded:bg-muted aria-expanded:text-foreground dark:hover-enabled:bg-muted/50",
        // Tints stay light enough for the red words to keep 4.5:1 on them (token contrast test).
        destructive:
          "bg-destructive/10 text-destructive hover-enabled:bg-destructive/15 active-enabled:bg-destructive/15 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/15 dark:hover-enabled:bg-destructive/18 dark:active-enabled:bg-destructive/18 dark:focus-visible:ring-destructive/40",
        // Underlined at rest, so a link is not told apart by colour alone. Light orange text is 2.94:1, so light
        // uses the darker accent text (≥4.5:1, checked by the token contrast test).
        link: "text-accent-foreground underline underline-offset-4 hover-enabled:decoration-2 dark:text-primary",
        // Whole-card and title buttons (G14): no fill, padding, height or gap, and the text reads like the content
        // around it. Keeps the focus ring, the cursors, the disabled look and the touch rule from the base, but not the
        // base's 1px press nudge: a whole-card button's hit area is its ::after stretched over the card, and a translate
        // makes the button that ::after's containing block while pressed, so the hit area shrinks to the button's own
        // text, the release lands outside it and the click never fires (focus cards opened only from their name).
        bare: "shrink justify-start text-left whitespace-normal",
      },
      size: {
        default:
          "h-11 gap-2 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "h-7 gap-1 rounded-md px-2.5 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "relative h-9 gap-1.5 rounded-[9px] px-3 text-[0.82rem] expanded-hit-area in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-12 gap-2 px-5 text-base has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        icon: "size-11",
        "icon-xs":
          "size-7 rounded-md in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "relative size-9 rounded-[9px] expanded-hit-area in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-12",
      },
    },
    compoundVariants: [
      // After the size classes, so a bare button drops every size's height, padding, gap and text size.
      {
        variant: "bare",
        className: "h-auto gap-0 p-0 text-[length:inherit] leading-[inherit] font-[weight:inherit] has-data-[icon=inline-end]:pr-0 has-data-[icon=inline-start]:pl-0",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * What a Button is doing, as people see and hear it. The caller is its one writer, through `busy`:
 * ready → busy when the button's action starts, busy → ready when the action settles.
 */
type ButtonActivity = "ready" | "busy"

/** The words a busy Button adds for screen readers when the caller gives no `busyLabel`: a spinner never stands alone. */
const BUTTON_ACTIVITY_WORDS: Record<ButtonActivity, string | null> = {
  ready: null,
  busy: "Working…",
}

/** A press on a button that cannot act right now does nothing, and a submit button does not submit. */
function ignorePress(event: React.MouseEvent<HTMLButtonElement>) {
  event.preventDefault()
}

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  busy = false,
  busyLabel,
  children,
  onClick,
  onPointerDown,
  onKeyDown,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** The action is running: the button shows its own spinner, says so, and ignores presses until it settles. */
    busy?: boolean
    /** What the button says while busy, such as "Refreshing…". Without it the label stays and "Working…" is spoken. */
    busyLabel?: React.ReactNode
  }) {
  const { t } = useI18n()
  const Comp = asChild ? Slot.Root : "button"
  const activity: ButtonActivity = busy ? "busy" : "ready"
  // aria-disabled keeps the button focusable so a reader can reach it and hear why it waits (G16); it must not act.
  const ignoresPresses = busy || props["aria-disabled"] === true || props["aria-disabled"] === "true"
  // A menu, list or dialog trigger (Radix gives it aria-haspopup) opens on pointer-down and on a key, not on click, so
  // a button that cannot act drops those handlers too; Tab still moves past it.
  const opensPopup = props["aria-haspopup"] !== undefined && props["aria-haspopup"] !== false && props["aria-haspopup"] !== "false"
  const ignoresPopupOpening = ignoresPresses && opensPopup
  const spokenActivity = BUTTON_ACTIVITY_WORDS[activity]

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-activity={activity}
      aria-busy={busy || undefined}
      className={cn(buttonVariants({ variant, size, className }), busy && size?.startsWith("icon") && "[&>svg:not([data-slot=button-spinner])]:hidden")}
      onClick={ignoresPresses ? ignorePress : onClick}
      onPointerDown={ignoresPopupOpening ? undefined : onPointerDown}
      onKeyDown={ignoresPopupOpening ? undefined : onKeyDown}
      {...props}
    >
      {busy && !asChild ? (
        <>
          <Loader2Icon data-slot="button-spinner" aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          {busyLabel ?? children}
          {busyLabel === undefined && spokenActivity && <span className="sr-only">{t(spokenActivity)}</span>}
        </>
      ) : children}
    </Comp>
  )
}

export { Button, buttonVariants, type ButtonActivity }
