import * as React from "react"
import { cn } from "cn"
import { FieldHelperText } from "@/components/ui/input"
import { useFieldError } from "./field-error"

/*
 * Same look as Input (D b21): a ≥3:1 edge, error, disabled and read-only states that differ, and the not-allowed
 * cursor when disabled. At least 80px tall at the 16px root (min-h-20, about three lines), so an empty box reads as
 * a place to write a reply, as in the review's textarea mockup, not as a one-line field. Put a FieldHelperText
 * under it for where the reply runs or why it is disabled, and a FieldCount near a length limit. `error`: what is
 * wrong, drawn underneath and linked, as on Input.
 */
function Textarea({
  className,
  error,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  ...props
}: React.ComponentProps<"textarea"> & { error?: React.ReactNode }) {
  const { hasError, errorLineId, fieldProps } = useFieldError(error, describedBy, invalid)
  const field = (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-20 w-full rounded-lg border border-control-edge bg-card px-3.5 py-2.5 shadow-[inset_0_1px_2px_rgb(74_46_20/0.05)] text-base transition-colors outline-none touch-target-size placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 [&[readonly]]:border-dashed [&[readonly]]:bg-transparent [&[readonly]]:shadow-none aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:[&[readonly]]:bg-transparent dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...fieldProps}
      {...props}
    />
  )
  if (!hasError) return field
  return <>{field}<FieldHelperText id={errorLineId} tone="error">{error}</FieldHelperText></>
}

export { Textarea }
export { FieldCount, FieldHelperText } from "@/components/ui/input"
