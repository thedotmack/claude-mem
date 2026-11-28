import * as React from "react"
import { cn } from "@/lib/utils"
import { CircleAlertIcon, type LucideIcon } from "lucide-react"
import { interpolate, useI18n } from "@/lib/i18n"
import { useFieldError } from "./field-error"

/** What the line under a field is saying. `hint`: an example or what happens next. `error`: what is wrong. */
type FieldHelperTone = "hint" | "error"

/**
 * How each tone shows beside its words, so an error is not told apart by colour alone: its mark, and the word a
 * screen reader hears first (as Alert's kinds do).
 */
const FIELD_HELPER_TONE: Record<FieldHelperTone, { icon: LucideIcon | null; spokenPrefix: string | null }> = {
  hint: { icon: null, spokenPrefix: null },
  error: { icon: CircleAlertIcon, spokenPrefix: "Error: " },
}

/*
 * Field look (D b12): a ≥3:1 edge (--control-edge), 44px tall (h-11 is 44px at the 16px root), and three states
 * that look different from each other: error (aria-invalid: destructive edge and ring), disabled (dimmed fill,
 * not-allowed cursor; pointer events stay on so the cursor shows, G16) and read-only (dashed edge, no fill).
 * The readonly attribute is matched directly because :read-only also matches disabled fields.
 * autoComplete defaults to "off": these fields hold rules, area names and replies, never personal details a
 * browser should fill in (D b12 F249); a caller that wants autofill passes its own value.
 * `error`: what is wrong with the value, in plain words; the field draws it underneath and links it (useFieldError).
 */
function Input({
  className,
  type,
  autoComplete = "off",
  error,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  ...props
}: React.ComponentProps<"input"> & { error?: React.ReactNode }) {
  const { hasError, errorLineId, fieldProps } = useFieldError(error, describedBy, invalid)
  const field = (
    <input
      type={type}
      data-slot="input"
      autoComplete={autoComplete}
      className={cn(
        "h-11 w-full min-w-0 rounded-lg border border-control-edge bg-card px-3.5 py-1 text-base shadow-[inset_0_1px_2px_rgb(74_46_20/0.05)] transition-colors outline-none touch-target-size file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 [&[readonly]]:border-dashed [&[readonly]]:bg-transparent [&[readonly]]:shadow-none aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/20 dark:disabled:bg-input/80 dark:[&[readonly]]:bg-transparent dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...fieldProps}
      {...props}
    />
  )
  if (!hasError) return field
  return <>{field}<FieldHelperText id={errorLineId} tone="error">{error}</FieldHelperText></>
}

/**
 * The line under a field (D b12 M253, b21 M440): an example or what happens next, which stays while typing
 * (unlike a placeholder), or with tone="error" what is wrong. Give it an id and point the field's
 * aria-describedby at it, or pass the words as the field's `error`, which does both. A disabled field uses it to say
 * what it waits for (G16).
 */
function FieldHelperText({
  className,
  tone = "hint",
  children,
  ...props
}: React.ComponentProps<"p"> & { tone?: FieldHelperTone }) {
  const { t } = useI18n()
  const { icon: Icon, spokenPrefix } = FIELD_HELPER_TONE[tone]
  return (
    <p
      data-slot="field-helper-text"
      data-tone={tone}
      className={cn("flex items-start gap-1.5 text-xs text-muted-foreground data-[tone=error]:text-destructive", className)}
      {...props}
    >
      {Icon && <Icon aria-hidden="true" className="mt-px size-3.5 shrink-0" />}
      <span>
        {spokenPrefix && <span className="sr-only">{t(spokenPrefix)}</span>}
        {children}
      </span>
    </p>
  )
}

/**
 * "22 / 60" under a field with a length limit (D b21 M442), in tabular mono figures. It takes the warning colour
 * when the field is full: the one point where the limit changes what typing does (the field's maxLength stops
 * input there). Screen readers hear "22 of 60 characters".
 */
function FieldCount({
  count,
  limit,
  className,
  ...props
}: Omit<React.ComponentProps<"p">, "children"> & { count: number; limit: number }) {
  const { t, locale } = useI18n()
  const shown = { count: count.toLocaleString(locale), limit: limit.toLocaleString(locale) }
  return (
    <p
      data-slot="field-count"
      data-full={count >= limit || undefined}
      className={cn("mono-number text-xs text-muted-foreground data-full:text-review-foreground", className)}
      {...props}
    >
      <span aria-hidden="true">{shown.count} / {shown.limit}</span>
      <span className="sr-only">{interpolate(t("{count} of {limit} characters"), shown)}</span>
    </p>
  )
}

export { Input, FieldHelperText, FieldCount, type FieldHelperTone }
