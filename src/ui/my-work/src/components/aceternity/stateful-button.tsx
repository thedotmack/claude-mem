import { cn } from "@/lib/utils";
import React from "react";
import { CheckIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { STATEFUL_BUTTON_STATE, type StatefulButtonState } from "./stateful-button-state";

// The states and their moves are defined once, beside this file (stateful-button-state.ts); this press handler is
// their one writer.
export type { StatefulButtonState } from "./stateful-button-state";

interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  className?: string;
  children: React.ReactNode;
  /**
   * The press's action. It resolves `false` when it did not save, and the caller says why under the button (with the
   * raw cause under Details, G17); anything else, or nothing, when it saved. A throw is a save that did not happen.
   */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => boolean | void | Promise<boolean | void>;
  /** The caller's icon, drawn in the slot the spinner and the check use, so the words never move sideways. */
  icon?: React.ReactNode;
  /** What the label says in a state other than rest. A state left out keeps the caller's label. */
  stateLabels?: Partial<Record<Exclude<StatefulButtonState, "rest">, React.ReactNode>>;
  /** Told on every state change: SaveButton announces the outcome from it. */
  onStateChange?: (state: StatefulButtonState) => void;
  /** The button itself, for a caller that moves focus to it after a save changes the row it sits in. */
  ref?: React.Ref<HTMLButtonElement>;
}

/**
 * The mark each state draws in the icon slot while it is the state on show; null leaves the caller's icon (or the
 * empty slot) there.
 */
const STATE_MARK: Record<StatefulButtonState, (() => React.ReactNode) | null> = {
  rest: null,
  // The ring turns only when motion is allowed (Spinner: motion-safe), here in the component itself (plan rule 8).
  saving: () => <Spinner className="size-4" />,
  saved: () => <CheckIcon aria-hidden="true" className="size-4" />,
  "not-saved": null,
};

/**
 * The icon slot, 16px, in every state's cell whether or not the caller passes an icon (c-save-button M: "the icon slot
 * is always there, so nothing moves"). A caller that puts its icon at the start of its label instead (`<CheckIcon />Mark
 * checked`) already has a 16px mark there, so an empty slot in a cell whose label starts with an icon steps aside
 * rather than doubling the gap.
 */
const ICON_SLOT_CLASS_NAME = "flex size-4 shrink-0 items-center justify-center [:has(>svg)>&:empty]:hidden";

/**
 * The vendor's stateful button, made this product's (c-aceternity-stateful-button):
 * - no look of its own: the green pill and its hover ring are gone, so the caller's classes (Button variants or setup
 *   CSS) draw it and no reset has to hold;
 * - one width in every state: each state's label sits in the same grid cell and only the current one is visible, so
 *   the widest label sets the width and nothing beside the button moves (layout-shift-avoid; the spinner and check grew
 *   from 0 to 20px before, an animated width). Each cell starts with the icon slot, so the slot and the words start at
 *   the same place in every state;
 * - while the action runs it is aria-busy and aria-disabled, and a second press is ignored, so a double press saves
 *   once (the Button primitive's G16 look: dimmed, the progress cursor);
 * - reduced motion is handled here: nothing moves but the spinner, that only when motion is allowed, and only while
 *   "Saving…" shows (the hidden cells draw no ring that keeps turning).
 */
export const StatefulButton = ({ className, children, onClick, icon, stateLabels, onStateChange, type, ...buttonProps }: ButtonProps) => {
  const [state, setState] = React.useState<StatefulButtonState>(STATEFUL_BUTTON_STATE.rest);
  // A press while the action runs is ignored: the state update is not seen until the next render.
  const runningRef = React.useRef(false);
  const callerDisabled = buttonProps["aria-disabled"] === true || buttonProps["aria-disabled"] === "true";

  const move = (next: StatefulButtonState) => {
    setState(next);
    onStateChange?.(next);
  };

  // A throw also ends in not-saved, then propagates. The action can unmount the button (the row it acts on moves
  // away); React ignores the state update then.
  const handleClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (runningRef.current || callerDisabled) return;
    runningRef.current = true;
    move(STATEFUL_BUTTON_STATE.saving);
    let next: StatefulButtonState = STATEFUL_BUTTON_STATE.notSaved;
    try {
      if ((await onClick?.(event)) !== false) next = STATEFUL_BUTTON_STATE.saved;
    } finally {
      runningRef.current = false;
      move(next);
    }
  };

  // Every state's label, one per state in the definition, so a new state draws (and is measured) like the others.
  const cells = Object.values(STATEFUL_BUTTON_STATE).map((shownIn) => {
    const onShow = state === shownIn;
    const mark = STATE_MARK[shownIn];
    const words = shownIn === STATEFUL_BUTTON_STATE.rest ? children : stateLabels?.[shownIn] ?? children;
    return (
      <span
        key={shownIn}
        data-stateful-label={shownIn}
        className={cn("col-start-1 row-start-1 inline-flex items-center justify-start gap-2", !onShow && "invisible")}
      >
        <span aria-hidden="true" data-icon-slot="" className={ICON_SLOT_CLASS_NAME}>{mark ? (onShow ? mark() : null) : icon}</span>
        {words}
      </span>
    );
  });

  return (
    <button
      type={type ?? "button"}
      {...buttonProps}
      data-save-state={state}
      aria-busy={state === STATEFUL_BUTTON_STATE.saving || undefined}
      aria-disabled={state === STATEFUL_BUTTON_STATE.saving ? true : buttonProps["aria-disabled"]}
      className={cn("inline-flex cursor-pointer items-center justify-center", className)}
      onClick={handleClick}
    >
      <span className="grid">{cells}</span>
    </button>
  );
};
