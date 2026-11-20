"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleFoldTrigger,
  CollapsibleTrigger,
  FOLD_TRIGGER_CLASS_NAME,
  FoldTriggerParts,
} from "@/components/ui/collapsible";
import { recordedTimeWords } from "@/lib/display-time";
import { interpolate, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import { CheckIcon, HistoryIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { memo, useLayoutEffect, useRef, useState } from "react";

export type ChainOfThoughtProps = ComponentProps<"div"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * One fold (the build story in the drawer, c-ai-chain-of-thought). The header and the content share one Collapsible,
 * so the header's button names what it opens (aria-controls) and says whether it is open; the vendor gave each its
 * own Collapsible kept in step through a context, so the button pointed at nothing.
 */
export const ChainOfThought = memo(
  ({
    className,
    defaultOpen = false,
    children,
    ...props
  }: ChainOfThoughtProps) => (
    <Collapsible defaultOpen={defaultOpen} className={cn("not-prose w-full space-y-4", className)} {...props}>
      {children}
    </Collapsible>
  )
);

export type ChainOfThoughtHeaderProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  /** How many steps the story holds, at the row's right end (c-ai-chain-of-thought M: "a trigger with a step count"). */
  count?: ReactNode;
};

/**
 * The shared fold row (G5): at least 44px, the chevron on the left that turns, the words, the count on the right, the
 * Button focus ring (the trigger was 21px). A history mark replaces the brain: this is what happened, not thinking
 * (c-ai-chain-of-thought F).
 */
export const ChainOfThoughtHeader = memo(
  ({ className, children, count, ...props }: ChainOfThoughtHeaderProps) => {
    const { t } = useI18n();
    return (
      <CollapsibleTrigger className={cn(FOLD_TRIGGER_CLASS_NAME, className)} {...props}>
        <FoldTriggerParts count={count}>
          <span className="inline-flex items-center gap-2">
            <HistoryIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            {children ?? t("Build story")}
          </span>
        </FoldTriggerParts>
      </CollapsibleTrigger>
    );
  }
);

export type ChainOfThoughtStepProps = ComponentProps<"div"> & {
  icon?: LucideIcon;
  label: ReactNode;
  description?: ReactNode;
  /** When it happened, in monospace above the words (the review's mockup); left out, nothing is drawn there. */
  time?: ReactNode;
  status?: "complete" | "active" | "pending";
};

const stepStatusStyles = {
  active: "text-foreground",
  complete: "text-foreground/90",
  pending: "text-muted-foreground",
};

/** A step's mark by its status, so a step's state never rests on colour (c-ai-chain-of-thought M: "a state marker"). */
const STEP_STATUS_MARK: Record<NonNullable<ChainOfThoughtStepProps["status"]>, () => ReactNode> = {
  complete: () => (
    <span className="flex size-4 items-center justify-center rounded-full bg-muted-foreground text-card">
      <CheckIcon className="size-3 stroke-3" />
    </span>
  ),
  active: () => <span className="block size-4 rounded-full border-2 border-working-foreground" />,
  pending: () => <span className="block size-4 rounded-full border-[1.5px] border-dashed border-control-edge" />,
};

export const ChainOfThoughtStep = memo(
  ({
    className,
    icon: Icon,
    label,
    description,
    time,
    status = "complete",
    children,
    ...props
  }: ChainOfThoughtStepProps) => (
    <div
      data-step-status={status}
      className={cn(
        "flex gap-2.5 text-sm",
        stepStatusStyles[status],
        className
      )}
      {...props}
    >
      <div aria-hidden="true" className="relative mt-0.5 shrink-0">
        {Icon ? <Icon className="size-4" /> : STEP_STATUS_MARK[status]()}
        <div className="absolute top-6 -bottom-2 left-1/2 -mx-px w-px bg-control-edge/55" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        {time && <div data-slot="chain-of-thought-step-time" className="mono-number text-xs text-muted-foreground">{time}</div>}
        <div className="font-medium [overflow-wrap:anywhere]">{label}</div>
        {description && (
          <div data-slot="chain-of-thought-step-description" className="text-muted-foreground text-xs">{description}</div>
        )}
        {children}
      </div>
    </div>
  )
);

/**
 * How many of the newest steps show before the rest fold: the review's build story mockup shows the newest five of
 * eleven steps (after/c-ai-chain-of-thought.png), and the drawer's Latest records shows its newest five too.
 */
const NEWEST_STEPS_SHOWN = 5;

export type ChainOfThoughtStepsProps = {
  /**
   * Oldest first, as the build story records them (data.ts Request['story']). `at`: the step's time, null when none
   * was recorded, absent when the step carries none; `description`: words about the step.
   */
  steps: readonly { label: string; at?: string | null; atIso?: string; description?: string; status: "complete" | "active" | "pending" }[];
};

/**
 * The story's steps in the order they happened: the newest five show, the earlier ones fold above them under the
 * shared fold row with their count (c-ai-chain-of-thought M: "the newest show and older ones fold"). Each step has its
 * mark, its time in the monospace column when it has one ("Date not recorded" when the review recorded none), and its
 * description under its words: a description is never drawn as a time. Nothing is dropped: the fold holds every
 * earlier step.
 */
export const ChainOfThoughtSteps = ({ steps }: ChainOfThoughtStepsProps) => {
  const { t } = useI18n();
  const earlier = steps.slice(0, Math.max(0, steps.length - NEWEST_STEPS_SHOWN));
  const newest = steps.slice(earlier.length);
  const timeOf = (step: ChainOfThoughtStepsProps["steps"][number]) =>
    step.at === undefined ? undefined : step.at === null ? t("Date not recorded") : recordedTimeWords(step.atIso, step.at, "time-or-day");
  const draw = (step: ChainOfThoughtStepsProps["steps"][number], index: number) => (
    <ChainOfThoughtStep key={`${index}:${step.label}`} label={step.label} time={timeOf(step)} description={step.description} status={step.status} />
  );
  return (
    <div data-slot="chain-of-thought-steps" className="space-y-3">
      {earlier.length > 0 && (
        <Collapsible>
          <CollapsibleFoldTrigger>
            {interpolate(earlier.length === 1 ? t("{count} earlier step") : t("{count} earlier steps"), { count: earlier.length })}
          </CollapsibleFoldTrigger>
          <CollapsibleContent className="space-y-3 pt-3">{earlier.map(draw)}</CollapsibleContent>
        </Collapsible>
      )}
      {newest.map((step, index) => draw(step, earlier.length + index))}
    </div>
  );
};

/**
 * The story's account in three lines, then the whole of it in place under "Read all" (c-ai-chain-of-thought M; the
 * paragraph ran about 1,100 characters). "Read all" shows only when the text is longer than three lines.
 */
export const ChainOfThoughtSummary = ({ children }: { children: string }) => {
  const { t } = useI18n();
  const [whole, setWhole] = useState(false);
  const [cut, setCut] = useState(false);
  const clampedRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const clamped = clampedRef.current;
    if (!clamped) return;
    // scrollHeight is a whole number while clientHeight can round down: 1px absorbs that rounding.
    const measure = () => setCut(clamped.scrollHeight > clamped.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(clamped);
    return () => observer.disconnect();
  }, [children, whole]);
  return (
    <Collapsible open={whole} onOpenChange={setWhole} className="space-y-2">
      {!whole && <p ref={clampedRef} data-slot="chain-of-thought-summary" className="line-clamp-3 text-sm text-muted-foreground">{children}</p>}
      <CollapsibleContent><p className="text-sm text-muted-foreground">{children}</p></CollapsibleContent>
      {(cut || whole) && <CollapsibleFoldTrigger>{whole ? t("Show less") : t("Read all")}</CollapsibleFoldTrigger>}
    </Collapsible>
  );
};

export type ChainOfThoughtSearchResultsProps = ComponentProps<"div">;

export const ChainOfThoughtSearchResults = memo(
  ({ className, ...props }: ChainOfThoughtSearchResultsProps) => (
    <div
      className={cn("flex flex-wrap items-center gap-2", className)}
      {...props}
    />
  )
);

export type ChainOfThoughtSearchResultProps = ComponentProps<typeof Badge>;

export const ChainOfThoughtSearchResult = memo(
  ({ className, children, ...props }: ChainOfThoughtSearchResultProps) => (
    <Badge
      className={cn("gap-1 px-2 py-0.5 font-normal text-xs", className)}
      variant="secondary"
      {...props}
    >
      {children}
    </Badge>
  )
);

export type ChainOfThoughtContentProps = ComponentProps<
  typeof CollapsibleContent
>;

/** It slides open (c-ai-chain-of-thought Keep), only when motion is allowed, here in the component (plan rule 8). */
export const ChainOfThoughtContent = memo(
  ({ className, children, ...props }: ChainOfThoughtContentProps) => (
    <CollapsibleContent
      className={cn(
        "mt-2 space-y-3 text-popover-foreground outline-none",
        "motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=closed]:slide-out-to-top-2 motion-safe:data-[state=open]:slide-in-from-top-2 motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=open]:animate-in",
        className
      )}
      {...props}
    >
      {children}
    </CollapsibleContent>
  )
);

export type ChainOfThoughtImageProps = ComponentProps<"div"> & {
  caption?: string;
};

export const ChainOfThoughtImage = memo(
  ({ className, children, caption, ...props }: ChainOfThoughtImageProps) => (
    <div className={cn("mt-2 space-y-2", className)} {...props}>
      <div className="relative flex max-h-[22rem] items-center justify-center overflow-hidden rounded-lg bg-muted p-3">
        {children}
      </div>
      {caption && <p className="text-muted-foreground text-xs">{caption}</p>}
    </div>
  )
);

ChainOfThought.displayName = "ChainOfThought";
ChainOfThoughtHeader.displayName = "ChainOfThoughtHeader";
ChainOfThoughtStep.displayName = "ChainOfThoughtStep";
ChainOfThoughtSearchResults.displayName = "ChainOfThoughtSearchResults";
ChainOfThoughtSearchResult.displayName = "ChainOfThoughtSearchResult";
ChainOfThoughtContent.displayName = "ChainOfThoughtContent";
ChainOfThoughtImage.displayName = "ChainOfThoughtImage";
