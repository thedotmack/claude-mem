"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Progress as ProgressPrimitive } from "radix-ui"
import { interpolate, useI18n } from "@/lib/i18n"

/**
 * Whether a bar has a measured value (D b14 M 293): "not reviewed yet" is not 0%. The one definition; the bar's look
 * and its fallback words are keyed by it.
 */
export type ProgressValueState = "known" | "unknown"

/** The bar's spoken name when the caller gives it none of its own. */
const PROGRESS_VALUE_STATE_WORDS: Record<ProgressValueState, string> = {
  known: "{percent}% complete",
  unknown: "Not measured yet",
}

/**
 * A progress bar that reports its value (D b14 M 294: aria-valuenow, -valuemin and -valuemax come from `value`).
 * `value={null}` is unknown: a dashed, empty track with no number, so it never reads as 0%.
 * The track keeps the muted fill, so every state's fill stays ≥3:1 against it, and carries a --control-edge rim, so the
 * empty part is ≥3:1 against the card (plan rule 7, G12; a solid track cannot satisfy both, see the Phase 1 contract).
 */
function Progress({
  className,
  value,
  max = 100,
  "aria-label": ariaLabel,
  ...props
}: Omit<React.ComponentProps<typeof ProgressPrimitive.Root>, "value"> & {
  value?: number | null
}) {
  const { t } = useI18n()
  const valueState: ProgressValueState = typeof value === "number" ? "known" : "unknown"
  const percent = typeof value === "number" ? Math.round((value / max) * 100) : null
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      data-value-state={valueState}
      value={value ?? null}
      max={max}
      aria-label={ariaLabel ?? interpolate(t(PROGRESS_VALUE_STATE_WORDS[valueState]), { percent: percent ?? "" })}
      className={cn(
        "relative flex h-1.5 w-full items-center overflow-hidden rounded-full bg-muted inset-ring inset-ring-control-edge data-[value-state=unknown]:border data-[value-state=unknown]:border-dashed data-[value-state=unknown]:border-control-edge data-[value-state=unknown]:bg-transparent data-[value-state=unknown]:inset-ring-0",
        className
      )}
      {...props}
    >
      {percent !== null && (
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className="size-full flex-1 rounded-full bg-primary transition-transform motion-reduce:transition-none"
          style={{ transform: `translateX(-${100 - percent}%)` }}
        />
      )}
    </ProgressPrimitive.Root>
  )
}

export { Progress }
