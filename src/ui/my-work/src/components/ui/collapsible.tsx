"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Collapsible as CollapsiblePrimitive } from "radix-ui"
import { ChevronRightIcon } from "lucide-react"

function Collapsible({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      {...props}
    />
  )
}

/**
 * The one fold row (decision G5, D b7): at least 44px tall at every width, a chevron on the left that turns when it
 * opens, the label, a count on the right, the pointer cursor and the Button focus ring. Its edge is the ≥3:1 control
 * edge (rule 7, G12; --border was 1.14–1.53:1). The Task and Chain of Thought triggers share it. Opening has no motion (D b7 K 146); only
 * the chevron turns, and not at all under reduced motion.
 */
const FOLD_TRIGGER_CLASS_NAME =
  "group/fold-trigger flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-lg border border-control-edge bg-transparent px-3 py-2 text-left text-sm font-medium text-foreground outline-none touch-target-size hover-enabled:bg-surface focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"

const FOLD_TRIGGER_CHEVRON_CLASS_NAME =
  "size-4 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-200 group-data-[state=open]/fold-trigger:rotate-90"

function FoldTriggerParts({ children, count }: { children: React.ReactNode; count?: React.ReactNode }) {
  return (
    <>
      <ChevronRightIcon aria-hidden="true" className={FOLD_TRIGGER_CHEVRON_CLASS_NAME} />
      <span className="min-w-0 flex-1">{children}</span>
      {count !== undefined && count !== null && (
        <span data-slot="fold-trigger-count" className="shrink-0 text-xs font-normal text-muted-foreground tabular">
          {count}
        </span>
      )}
    </>
  )
}

/** `count`: how many things the fold holds ("3 parts", "1 conversation"), shown at the row's right end. */
function CollapsibleFoldTrigger({
  className,
  children,
  count,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger> & { count?: React.ReactNode }) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-fold-trigger"
      className={cn(FOLD_TRIGGER_CLASS_NAME, className)}
      {...props}
    >
      <FoldTriggerParts count={count}>{children}</FoldTriggerParts>
    </CollapsiblePrimitive.CollapsibleTrigger>
  )
}

function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      {...props}
    />
  )
}

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleFoldTrigger,
  CollapsibleContent,
  FOLD_TRIGGER_CLASS_NAME,
  FoldTriggerParts,
}
