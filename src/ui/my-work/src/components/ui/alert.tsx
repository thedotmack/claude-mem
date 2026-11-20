import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { CircleAlertIcon, InfoIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react"
import { useI18n } from "@/lib/i18n"

/**
 * What an alert says (D b2, c-ui-alert): a plain notice, something that needs the person's attention, or a failure.
 * The one definition of the alert kind; the variant names, words and icons below are Records over it.
 */
export type AlertKind = "notice" | "attention" | "destructive"

/** `variant` keeps its shipped names (D b2: "the variant names stay"): `default` is the notice. */
type AlertVariant = "default" | Exclude<AlertKind, "notice">
const ALERT_KIND_OF_VARIANT: Record<AlertVariant, AlertKind> = {
  default: "notice",
  attention: "attention",
  destructive: "destructive",
}

/** Read out before the message, so the kind never rests on colour and icon alone (color-not-only). */
const ALERT_KIND_WORDS: Record<AlertKind, string> = {
  notice: "Notice: ",
  attention: "Needs attention: ",
  destructive: "Error: ",
}

const ALERT_KIND_ICON: Record<AlertKind, LucideIcon> = {
  notice: InfoIcon,
  attention: TriangleAlertIcon,
  destructive: CircleAlertIcon,
}

/** Every edge is ≥3:1 against the page and the card in both themes (plan rule 7; D b2 F 45). */
const ALERT_VARIANT_SURFACE: Record<AlertVariant, string> = {
  default: "border-control-edge bg-card text-card-foreground *:[svg]:text-current",
  attention: "border-review-foreground bg-review text-foreground *:[svg]:text-review-foreground",
  destructive:
    "border-destructive bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current",
}

// Columns: the icon, the message, then the action (a retry) beside the message. A caller's own icon replaces the
// kind's icon, so an alert never draws two.
const alertVariants = cva(
  "group/alert relative grid w-full items-start gap-x-3 gap-y-0.5 rounded-xl border px-4 py-3 text-left text-sm has-[>svg]:grid-cols-[auto_1fr] has-data-[slot=alert-action]:grid-cols-[1fr_auto] has-[>svg]:has-data-[slot=alert-action]:grid-cols-[auto_1fr_auto] *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg:not([class*='size-'])]:size-4 [&:has(>svg:not([data-slot=alert-kind-icon]))>[data-slot=alert-kind-icon]]:hidden",
  {
    variants: {
      variant: ALERT_VARIANT_SURFACE,
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/**
 * A message about the page. `role` defaults to a quiet `status`; pass `role="alert"` only for something that must
 * interrupt (D b2: 47 cards each announced as an urgent alert). Naming the kind with `variant` draws its icon and reads
 * its word first; callers that draw their own icon or layout pass no variant and keep exactly what they draw.
 */
function Alert({
  className,
  variant,
  role = "status",
  children,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  const { t } = useI18n()
  const namedKind = variant ? ALERT_KIND_OF_VARIANT[variant] : null
  const KindIcon = namedKind ? ALERT_KIND_ICON[namedKind] : null
  return (
    <div
      data-slot="alert"
      data-kind={namedKind ?? undefined}
      role={role}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {KindIcon && <KindIcon data-slot="alert-kind-icon" aria-hidden="true" />}
      {namedKind && <span className="sr-only">{t(ALERT_KIND_WORDS[namedKind])}</span>}
      {children}
    </div>
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground group-has-[>svg]/alert:col-start-2 md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  )
}

/** The alert's one action, such as "Try again": inside the box, beside the message (D b2 M 50). */
function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("col-start-[-2] row-span-2 row-start-1 flex items-center gap-2 self-center", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
