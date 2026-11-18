import React, { useEffect, useRef, useState } from "react";
import {
  motion,
  useReducedMotion,
  useTransform,
  useScroll,
  useSpring,
} from "motion/react";
import { cn } from "@/lib/utils";

/*
 * Local changes (c-aceternity-tracing-beam): the rail and its light use the page's own colours (the vendor's emerald
 * dot and cyan-to-violet gradient were not this palette), the rail follows the content's height as entries open and
 * close (it was measured once), and under reduced motion the light and the dot stay still, here in the component
 * (plan rule 8). The caller marks the entry being read on the rail (pages/my-work.tsx StorySheet), so the rail stays on
 * one line, 19px from the left, to its end: the vendor's path jogged back to x=1 for its last fifth, where the newest
 * entry's mark then sat 18px off the line.
 */

/** The rail: one vertical line at x=19 (the vendor's start above the top is kept, out of view). */
const RAIL_PATH = (height: number) => `M 1 0V -36 l 18 24 V ${height}`
export const TracingBeam = ({
  children,
  className,
  scrollContainer,
}: {
  children: React.ReactNode;
  className?: string;
  /** Local addition: the element that scrolls, when it isn't the window (a sheet or drawer). */
  scrollContainer?: React.RefObject<HTMLElement | null>;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    container: scrollContainer,
    offset: ["start start", "end start"],
  });

  const contentRef = useRef<HTMLDivElement>(null);
  const [svgHeight, setSvgHeight] = useState(0);
  const [scrolled, setScrolled] = useState(false);

  // The rail is as tall as the content, also after a folded entry opens or closes.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => setSvgHeight(content.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => scrollYProgress.on("change", (progress) => setScrolled(progress > 0)), [scrollYProgress]);

  const y1 = useSpring(
    useTransform(scrollYProgress, [0, 0.8], [50, svgHeight]),
    {
      stiffness: 500,
      damping: 90,
    },
  );
  const y2 = useSpring(
    useTransform(scrollYProgress, [0, 1], [50, svgHeight - 200]),
    {
      stiffness: 500,
      damping: 90,
    },
  );

  return (
    <motion.div
      ref={ref}
      className={cn("relative mx-auto h-full w-full max-w-4xl", className)}
    >
      {/* Local fix: md:-left-20 put the beam outside a narrow container (a sheet); the caller pads the content instead. */}
      <div className="absolute top-3 -left-4" aria-hidden="true">
        <div className="ml-[27px] flex h-4 w-4 items-center justify-center rounded-full border border-control-edge bg-card">
          <div
            className={cn(
              "h-2 w-2 rounded-full border",
              !reduceMotion && "transition-colors duration-200",
              scrolled ? "border-control-edge bg-card" : "border-primary-deep bg-primary",
            )}
          />
        </div>
        <svg
          viewBox={`0 0 20 ${svgHeight}`}
          width="20"
          height={svgHeight} // Set the SVG height
          className="ml-4 block"
          aria-hidden="true"
        >
          <path
            d={RAIL_PATH(svgHeight)}
            fill="none"
            style={{ stroke: "var(--control-edge)" }}
            strokeOpacity="0.6"
          ></path>
          {!reduceMotion && (
            <motion.path
              d={RAIL_PATH(svgHeight)}
              fill="none"
              stroke="url(#tracing-beam-gradient)"
              strokeWidth="1.25"
            ></motion.path>
          )}
          <defs>
            <motion.linearGradient
              id="tracing-beam-gradient"
              gradientUnits="userSpaceOnUse"
              x1="0"
              x2="0"
              y1={y1} // set y1 for gradient
              y2={y2} // set y2 for gradient
            >
              <stop style={{ stopColor: "var(--primary)" }} stopOpacity="0"></stop>
              <stop style={{ stopColor: "var(--primary)" }}></stop>
              <stop offset="0.325" style={{ stopColor: "var(--primary-bright)" }}></stop>
              <stop offset="1" style={{ stopColor: "var(--accent-foreground)" }} stopOpacity="0"></stop>
            </motion.linearGradient>
          </defs>
        </svg>
      </div>
      <div ref={contentRef}>{children}</div>
    </motion.div>
  );
};
