import * as React from "react"

/**
 * What a field (Input, Textarea) adds when its `error` is given (D b12 M 254): it says so with aria-invalid, which
 * also draws the error look, and points aria-describedby at the error line it draws right under itself, so the words
 * are read with the field. The caller's own aria-describedby (a hint line) stays first.
 */
export function useFieldError(
  error: React.ReactNode,
  describedBy: string | undefined,
  invalid: React.AriaAttributes["aria-invalid"]
) {
  const errorLineId = React.useId()
  const hasError = error !== undefined && error !== null && error !== false && error !== ""
  return {
    hasError,
    errorLineId,
    fieldProps: {
      "aria-invalid": hasError ? true : invalid,
      "aria-describedby": [describedBy, hasError ? errorLineId : undefined].filter(Boolean).join(" ") || undefined,
    },
  }
}
