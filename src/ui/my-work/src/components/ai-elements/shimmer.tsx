"use client";

import { cn } from "@/lib/utils";
import type { MotionProps } from "motion/react";
import { motion, useReducedMotion } from "motion/react";
import type { CSSProperties, ElementType, JSX } from "react";
import { memo, useMemo } from "react";

type MotionHTMLProps = MotionProps & Record<string, unknown>;

// Cache motion components at module level to avoid creating during render
const motionComponentCache = new Map<
  keyof JSX.IntrinsicElements,
  React.ComponentType<MotionHTMLProps>
>();

const getMotionComponent = (element: keyof JSX.IntrinsicElements) => {
  let component = motionComponentCache.get(element);
  if (!component) {
    component = motion.create(element);
    motionComponentCache.set(element, component);
  }
  return component;
};

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

/**
 * The words' own colour and the sweep's light, from the theme's tokens (c-ai-shimmer). A caller may still set the
 * vendor's two variables; otherwise the words are the muted text colour, never transparent with nothing behind them
 * (the vendor's `--color-*` theme variables are not emitted by `@theme inline`, so the card set them by hand).
 */
const SHIMMER_BASE = "var(--color-muted-foreground, var(--muted-foreground))";
const SHIMMER_LIGHT = "var(--color-background, var(--foreground))";

/**
 * Text being written, with a small mark in front so the state never rests on the sweep alone (c-ai-shimmer): a turning
 * ring while motion is allowed, three still dots when it is not. Under reduced motion the words are plain, in their
 * solid colour, and nothing moves; the component checks the preference itself (plan rule 8), not only through the
 * app's MotionConfig, because MotionConfig does not stop this endless background sweep.
 */
const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const reduceMotion = useReducedMotion();
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread]
  );

  return (
    <Component data-slot="shimmer" className={cn("inline-flex max-w-full items-center gap-1.5", className)}>
      {reduceMotion ? (
        <span data-slot="shimmer-mark" aria-hidden="true" className="inline-flex shrink-0 items-center gap-0.5" style={{ color: SHIMMER_BASE }}>
          <span className="size-1 rounded-full bg-current" />
          <span className="size-1 rounded-full bg-current" />
          <span className="size-1 rounded-full bg-current" />
        </span>
      ) : (
        <span data-slot="shimmer-mark" aria-hidden="true" className="size-[0.9em] shrink-0 motion-safe:animate-spin rounded-full border-[1.5px] border-current border-t-transparent" style={{ color: SHIMMER_BASE }} />
      )}
      {reduceMotion ? (
        <span data-slot="shimmer-text" style={{ color: SHIMMER_BASE }}>{children}</span>
      ) : (
        <SweptText duration={duration} spread={dynamicSpread}>{children}</SweptText>
      )}
    </Component>
  );
};

/** The swept words are always a span, so its motion component is made once, here, not during a render. */
const MotionSpan = getMotionComponent("span");

function SweptText({ children, duration, spread }: { children: string; duration: number; spread: number }) {
  return (
    <MotionSpan
      data-slot="shimmer-text"
      animate={{ backgroundPosition: "0% center" }}
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text",
        "[background-repeat:no-repeat,padding-box]"
      )}
      initial={{ backgroundPosition: "100% center" }}
      style={
        {
          // The solid colour stays under the gradient: where background-clip:text is not drawn, the words still show.
          color: SHIMMER_BASE,
          WebkitTextFillColor: "transparent",
          backgroundImage: `linear-gradient(90deg, #0000 calc(50% - ${spread}px), ${SHIMMER_LIGHT}, #0000 calc(50% + ${spread}px)), linear-gradient(${SHIMMER_BASE}, ${SHIMMER_BASE})`,
        } as CSSProperties
      }
      transition={{
        duration,
        ease: "linear",
        repeat: Number.POSITIVE_INFINITY,
      }}
    >
      {children}
    </MotionSpan>
  );
}

export const Shimmer = memo(ShimmerComponent);
