import * as React from "react"
import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

/**
 * A working ring that always has words beside it, announced once (D b18 M 372: the ring and its line were both
 * `role="status"`, so the drawer said it twice). With `label`, the spinner draws the words itself inside one status
 * region. Without it, the ring is decorative and the caller's words beside it (a status line, a button's label) speak.
 * The ring turns only when motion is allowed; stopped, the words carry the meaning.
 */
function Spinner({
  className,
  label,
  ...props
}: React.ComponentProps<"svg"> & { label?: React.ReactNode }) {
  const ring = (
    <Loader2Icon
      data-slot="spinner"
      aria-hidden="true"
      className={cn("size-4 shrink-0 motion-safe:animate-spin", className)}
      {...props}
    />
  )
  if (label === undefined || label === null) return ring
  return (
    <span data-slot="spinner-status" role="status" className="inline-flex items-center gap-2">
      {ring}
      <span>{label}</span>
    </span>
  )
}

export { Spinner }
