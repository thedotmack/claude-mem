import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"
import { interpolate, useI18n } from "@/lib/i18n"

/*
 * A chip never cuts its words off (D b3 M71): in a wrapping row it moves to the next line first, and only a label
 * longer than the whole row wraps inside the pill. A badge drawn as a link or button (asChild) shows the hand
 * cursor and takes presses across 44×44px without growing (expanded-hit-area).
 */
const badgeVariants = cva(
  "group/badge inline-flex min-h-6 w-fit max-w-full shrink-0 items-center justify-center gap-1.5 rounded-full border border-transparent px-2.5 py-0.5 text-center text-xs font-medium whitespace-normal wrap-anywhere transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [a]:relative [a]:cursor-pointer [a]:expanded-hit-area [button]:relative [button]:cursor-pointer [button]:expanded-hit-area [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        // Tints stay light enough for the red words to keep 4.5:1 on them (token contrast test).
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/15 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/15 dark:[a]:hover:bg-destructive/18",
        // The state badge on cards and rows: a pill edge ≥3:1 on the card (D b3 M70).
        outline:
          "border-control-edge bg-card text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        // Light orange text is 2.94:1, so light uses the darker accent text, as the link Button does.
        link: "text-accent-foreground underline-offset-4 hover:underline dark:text-primary",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

/**
 * The chip that ends a shortened row of chips: "+3 more" (D b3 M71, chip-collection-reflow). The caller shows the
 * first chips and passes how many it left out, so the hidden count is always on screen (plan rule 5). With
 * `onShowAll` it is a button that shows the rest.
 */
function BadgeMore({
  hiddenCount,
  onShowAll,
  className,
  "aria-label": ariaLabel,
}: {
  hiddenCount: number
  onShowAll?: () => void
  className?: string
  "aria-label"?: string
}) {
  const { t } = useI18n()
  if (hiddenCount <= 0) return null
  const words = interpolate(t("+{count} more"), { count: hiddenCount })
  if (!onShowAll) {
    return <Badge variant="outline" data-slot="badge-more" className={cn("font-normal", className)} aria-label={ariaLabel}>{words}</Badge>
  }
  return (
    <Badge asChild variant="outline" className={cn("font-normal", className)}>
      <button type="button" data-slot="badge-more" onClick={onShowAll} aria-label={ariaLabel}>{words}</button>
    </Badge>
  )
}

export { Badge, BadgeMore, badgeVariants }
