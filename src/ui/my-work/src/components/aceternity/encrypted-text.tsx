import React, { useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

type EncryptedTextProps = {
  text: string;
  className?: string;
  /**
   * Time in milliseconds between one letter starting to fade in and the next, left to right. Callers divide the
   * whole reveal by the text's length (the request card: about half a second). The default, the vendor's 50ms, reveals
   * a ten-letter word in that half second (c-aceternity-encrypted-text M: "over about half a second").
   */
  revealDelayMs?: number;
  /**
   * No effect since 16.0.0: the letters are always the real ones, so there is nothing to draw from it. Kept so callers
   * still compile (components/focus-header.tsx, and PR #6054's copy of it).
   */
  charset?: string;
  /** No effect since 16.0.0: nothing flips any more. Kept so callers still compile. */
  flipDelayMs?: number;
  /** No effect since 16.0.0: no letter is scrambled any more. Kept so callers still compile. */
  encryptedClassName?: string;
  /** CSS class for the letters. */
  revealedClassName?: string;
};

/**
 * How light a letter starts, and how long one letter takes to reach full strength. The real letters are on screen from
 * the first frame, only lighter, so the words can be read at once and the title keeps its line breaks the whole time
 * (c-aceternity-encrypted-text: mid-way the old scramble read "Show rlll jCz@- …" and its line breaks moved).
 * - A quarter strength: the letters show as shapes from the first frame and still read as arriving, 2.12:1 against the
 *   dark card and 1.71:1 against the light one (measured: foreground #f4ece2 over card #201b17, #1f1a17 over #fffdf9);
 *   each reaches its resting 14.6:1 and 17.0:1 within one letter's fade.
 * - 160ms a letter: inside the 150–300ms that UI UX Pro Max's pre-delivery checklist gives a transition, near its short
 *   end so that, with the reveal spread over half a second, the last letter is whole by about 0.66s.
 */
const LETTER_STARTS_AT_OPACITY = 0.25;
const LETTER_FADE_MS = 160;

/**
 * Texts already revealed in this page. A title fades in once per page, the first time it is drawn: a refresh, a
 * re-render or a card drawn again later shows it plain (c-aceternity-encrypted-text F: after a refresh many cards played
 * at once). Keeping the record here, not in the card, is how "once, not on every refresh" survives a card that is
 * unmounted and mounted again (the board redraws its cards as they move between groups). So a name shown before in this
 * page does not fade again: switching back to a focus area shows its name plain, and a second request given the same
 * new title shows it plain. One entry per distinct text revealed; a page holds a few hundred titles at most.
 */
const revealedTexts = new Set<string>();

/**
 * A just-written text arriving: its real letters fade in from left to right (the vendor's two seconds of random symbols
 * are gone). Under reduced motion the text is simply there; the component checks the preference itself (plan rule 8).
 */
export const EncryptedText: React.FC<EncryptedTextProps> = ({
  text,
  className,
  revealDelayMs = 50,
  revealedClassName,
}) => {
  const reduceMotion = useReducedMotion();
  const containerRef = useRef<HTMLSpanElement>(null);
  // Decided when this text is first drawn here: later renders of the same text keep the answer and never replay, even
  // after the effect below has added it to revealedTexts. A new text is decided afresh (React's derived-state pattern).
  const [decision, setDecision] = useState(() => ({ text, plays: !reduceMotion && !revealedTexts.has(text) }));
  if (decision.text !== text) setDecision({ text, plays: !reduceMotion && !revealedTexts.has(text) });
  const playsNow = decision.text === text && decision.plays && !reduceMotion;

  // Before paint, so the first frame already shows the lighter letters, never the whole title for a moment.
  useLayoutEffect(() => {
    revealedTexts.add(text);
    if (!playsNow) return;
    const letters = containerRef.current?.querySelectorAll<HTMLElement>("[data-letter]") ?? [];
    const fades = Array.from(letters, (letter, index) => letter.animate(
      [{ opacity: LETTER_STARTS_AT_OPACITY }, { opacity: 1 }],
      // `backwards`: a letter waiting for its turn keeps the starting opacity; once done it is plain text again.
      { duration: LETTER_FADE_MS, delay: index * Math.max(0, revealDelayMs), easing: "ease-out", fill: "backwards" },
    ));
    return () => fades.forEach((fade) => fade.cancel());
  }, [text, playsNow, revealDelayMs]);

  if (!text) return null;
  if (!playsNow) return <span className={cn(className, revealedClassName)}>{text}</span>;

  return (
    <span ref={containerRef} data-encrypted-text="revealing" className={className}>
      {Array.from(text).map((char, index) => (
        <span key={index} data-letter className={revealedClassName}>{char}</span>
      ))}
    </span>
  );
};
