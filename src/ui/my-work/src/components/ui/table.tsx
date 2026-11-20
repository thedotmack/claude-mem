import * as React from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { interpolate, useI18n } from "@/lib/i18n"
import { LINE_ROWS_PER_PAGE } from "@/live/card-groups"
import { actionableElementInside } from "./interaction-behavior"

/**
 * How many rows a long list draws at a time (decision G4): the one 50-row page, live/card-groups.ts LINE_ROWS_PER_PAGE
 * (UI UX Pro Max `virtualize-lists` draws at most 50 rows at once), under the name the table's callers know.
 * TablePageFooter says how many are shown and offers the next page.
 */
export const LIST_ROWS_PER_PAGE = LINE_ROWS_PER_PAGE

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-[0.94rem]", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * A row. With `onActivate` the whole row opens something (D b20 M 420): it is a Tab stop, Enter or Space opens it,
 * a click anywhere on it opens it except on a control inside it (a link, a button), and it shows hover and focus.
 */
function TableRow({
  className,
  onActivate,
  onClick,
  onKeyDown,
  ...props
}: React.ComponentProps<"tr"> & { onActivate?: () => void }) {
  return (
    <tr
      data-slot="table-row"
      data-activatable={onActivate ? "" : undefined}
      tabIndex={onActivate ? 0 : undefined}
      onClick={(event) => {
        onClick?.(event)
        if (!onActivate || event.defaultPrevented) return
        if (actionableElementInside(event.currentTarget, event.target)) return
        onActivate()
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        // Keys pressed on a control inside the row belong to that control.
        if (!onActivate || event.defaultPrevented || event.target !== event.currentTarget) return
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        onActivate()
      }}
      className={cn(
        "border-b border-border/80 transition-colors hover:bg-surface has-aria-expanded:bg-surface data-[state=selected]:bg-accent/60 data-activatable:cursor-pointer focus-visible:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        className
      )}
      {...props}
    />
  )
}

/** `numeric`: a column of numbers or times, right-aligned (D b20 M 418). */
function TableHead({
  className,
  numeric = false,
  ...props
}: React.ComponentProps<"th"> & { numeric?: boolean }) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-12 px-4 text-left align-middle text-[0.82rem] font-medium whitespace-nowrap text-muted-foreground first:pl-6 last:pr-6 [&:has([role=checkbox])]:pr-0",
        numeric && "text-right",
        className
      )}
      {...props}
    />
  )
}

/**
 * Rows are 48px at the 16px base (decision G18). `numeric`: monospace tabular figures, right-aligned (D b20 M 418),
 * in the style shared with progress numbers and toggle counts.
 */
function TableCell({
  className,
  numeric = false,
  ...props
}: React.ComponentProps<"td"> & { numeric?: boolean }) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "h-12 px-4 py-2 align-middle whitespace-nowrap first:pl-6 last:pr-6 [&:has([role=checkbox])]:pr-0",
        numeric && "text-right mono-number",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

/**
 * Under a paged list (D b20 M 419, decision G4): how many rows are shown, and the next page ("Show 50 more · 68 left").
 * `children` adds to the count line, such as "sorted by Status". Nothing is hidden without the count saying so.
 */
function TablePageFooter({
  className,
  shownCount,
  totalCount,
  pageSize = LIST_ROWS_PER_PAGE,
  onShowMore,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  shownCount: number
  totalCount: number
  pageSize?: number
  onShowMore: () => void
}) {
  const { t } = useI18n()
  if (shownCount > totalCount) throw new Error(`TablePageFooter shows ${shownCount} rows of only ${totalCount}`)
  const remainingCount = totalCount - shownCount
  return (
    <div
      data-slot="table-page-footer"
      className={cn("flex flex-wrap items-center justify-between gap-3 pt-3 text-sm text-muted-foreground", className)}
      {...props}
    >
      <p aria-live="polite" className="tabular">
        {interpolate(t("Showing {shown} of {total}"), { shown: shownCount, total: totalCount })}
        {children !== undefined && children !== null && <> · {children}</>}
      </p>
      {remainingCount > 0 && (
        <Button variant="outline" onClick={onShowMore}>
          {interpolate(t("Show {count} more"), { count: Math.min(pageSize, remainingCount) })}
          <span className="font-normal text-muted-foreground tabular">
            · {interpolate(t("{count} left"), { count: remainingCount })}
          </span>
        </Button>
      )}
    </div>
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  TablePageFooter,
}
