"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FOLD_TRIGGER_CLASS_NAME,
  FoldTriggerParts,
} from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { interpolate, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CheckIcon } from "lucide-react";
import type { ComponentProps } from "react";

export type TaskItemFileProps = ComponentProps<"div">;

export const TaskItemFile = ({
  children,
  className,
  ...props
}: TaskItemFileProps) => (
  <div
    className={cn(
      "inline-flex items-center gap-1 rounded-md border bg-secondary px-1.5 py-0.5 text-foreground text-xs",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type TaskItemProps = ComponentProps<"div"> & {
  /**
   * Whether the task is done (c-ai-task M): a filled check in front and the words in full, never struck through (a
   * line through 14px text was hard to read, and eight struck lines were noise). An open task gets an empty box. Left
   * out, the item draws as the vendor's plain row.
   */
  done?: boolean;
};

export const TaskItem = ({ children, className, done, ...props }: TaskItemProps) => {
  const { t } = useI18n();
  if (done === undefined) {
    return (
      <div className={cn("text-muted-foreground text-sm", className)} {...props}>
        {children}
      </div>
    );
  }
  return (
    <div data-task-done={done} className={cn("flex items-start gap-2.5 text-sm", done ? "text-muted-foreground" : "text-foreground", className)} {...props}>
      {done ? (
        <span aria-hidden="true" className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-shipped-foreground text-card">
          <CheckIcon className="size-3 stroke-3" />
        </span>
      ) : (
        <span aria-hidden="true" className="mt-0.5 size-4 shrink-0 rounded-[4px] border-[1.5px] border-control-edge" />
      )}
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {done && <span className="sr-only">{t("Done:")} </span>}
        {children}
      </span>
    </div>
  );
};

export type TaskProps = ComponentProps<typeof Collapsible>;

export const Task = ({
  defaultOpen = true,
  className,
  ...props
}: TaskProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
  /** With `total`: how many of the stream's tasks are done, drawn as a small bar and a monospace count (c-ai-task M). */
  done?: number;
  total?: number;
};

/**
 * A workstream's row: the shared fold row (G5) without its own edge, because the rows sit in one divided list. Its
 * chevron turns, its name wraps (raw ids are one long word), and at the right a small bar and "8 of 8 done", so a
 * finished stream and one with six open tasks differ while closed (c-ai-task F).
 */
export const TaskTrigger = ({
  children,
  className,
  title,
  done,
  total,
  ...props
}: TaskTriggerProps) => {
  const { t } = useI18n();
  const counted = done !== undefined && total !== undefined && total > 0;
  return (
    <CollapsibleTrigger asChild className={cn("group", className)} {...props}>
      {children ?? (
        <button type="button" className={cn(FOLD_TRIGGER_CLASS_NAME, "border-transparent px-1")}>
          <FoldTriggerParts
            count={counted ? (
              <span className="inline-flex items-center gap-2">
                <Progress aria-hidden="true" value={done} max={total}
                  className={cn("h-1.5 w-12", done === total ? "[&_[data-slot=progress-indicator]]:bg-shipped-foreground" : "[&_[data-slot=progress-indicator]]:bg-working-foreground")} />
                <span className="mono-number">{interpolate(t("{done} of {total} done"), { done, total })}</span>
              </span>
            ) : undefined}
          >
            <span className="[overflow-wrap:anywhere]">{title}</span>
          </FoldTriggerParts>
        </button>
      )}
    </CollapsibleTrigger>
  );
};

export type TaskContentProps = ComponentProps<typeof CollapsibleContent>;

/** The slide in and out runs only when motion is allowed, here in the component (plan rule 8). */
export const TaskContent = ({
  children,
  className,
  ...props
}: TaskContentProps) => (
  <CollapsibleContent
    className={cn(
      "text-popover-foreground outline-none motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=closed]:slide-out-to-top-2 motion-safe:data-[state=open]:slide-in-from-top-2 motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=open]:animate-in",
      className
    )}
    {...props}
  >
    <div className="mt-2 space-y-2 border-control-edge/55 border-l-2 pl-4">
      {children}
    </div>
  </CollapsibleContent>
);
