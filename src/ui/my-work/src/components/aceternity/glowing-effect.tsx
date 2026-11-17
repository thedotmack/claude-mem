import { memo, useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/use-media";
import { animate } from "motion/react";

interface GlowingEffectProps {
  /**
   * The one colour of the edge, the left bar and the brightening near the pointer (default variant): a palette token,
   * never a raw colour (c-aceternity-glowing-effect F: four raw hex colours that meant nothing).
   */
  color?: string;
  blur?: number;
  /**
   * The pointer layer's three distances; the defaults are the vendor's, and a caller states its own reason beside the
   * values it passes (request-card.tsx). `inactiveZone`: the share of the card's half-size around its centre where the
   * edge does not brighten. `proximity`: how far outside the card, in px, the pointer still brightens it. `spread`: half
   * the bright arc's width, in degrees.
   */
  inactiveZone?: number;
  proximity?: number;
  spread?: number;
  variant?: "default" | "white";
  glow?: boolean;
  className?: string;
  disabled?: boolean;
  movementDuration?: number;
  borderWidth?: number;
}
/**
 * The mark of a card that needs you (c-aceternity-glowing-effect, decision for Phase 5):
 * - `glow`: an always-on edge in one palette colour plus a thin bar on the left edge, so the card stands out on a phone,
 *   by keyboard and under reduced motion too (it showed only when a mouse was near). The edge is the colour at 80%,
 *   the strength of the state pill's edge, ≥3:1 on the card and the page in both themes (rule 7); the bar is full
 *   strength.
 * - near the pointer the edge brightens to full strength, in the same colour, along the side the pointer is on. That
 *   layer follows the pointer only while the card is on screen, and is off when `disabled` and under reduced motion,
 *   which the component checks itself whatever its caller passes (plan rule 8), leaving the resting edge.
 * Nothing draws outside the card: no blur unless a caller asks, so no halo at rest. Keyboard focus is the card's own
 * orange ring (request-card.tsx).
 */
const GlowingEffect = memo(
  ({
    color = "var(--attention-foreground)",
    blur = 0,
    inactiveZone = 0.7,
    proximity = 0,
    spread = 20,
    variant = "default",
    glow = false,
    className,
    movementDuration = 2,
    borderWidth = 1,
    disabled = true,
  }: GlowingEffectProps) => {
    // The pointer layer moves, so it is off under reduced motion here in the component (plan rule 8), not only when a
    // caller remembers to pass `disabled`; the resting edge and bar do not move and stay.
    const reduceMotion = usePrefersReducedMotion();
    const followsPointer = !disabled && !reduceMotion;
    const containerRef = useRef<HTMLDivElement>(null);
    const lastPosition = useRef({ x: 0, y: 0 });
    const animationFrameRef = useRef<number>(0);
    const glowAnimation = useRef<ReturnType<typeof animate> | null>(null);

    const handleMove = useCallback(
      (e?: MouseEvent | { x: number; y: number }) => {
        if (!containerRef.current) return;
        if (e) lastPosition.current = { x: e.x, y: e.y };
        // Keep only the latest pointer position, with one layout read per frame.
        if (animationFrameRef.current) return;

        animationFrameRef.current = requestAnimationFrame(() => {
          animationFrameRef.current = 0;
          const element = containerRef.current;
          if (!element) return;

          const { left, top, width, height } = element.getBoundingClientRect();
          const { x: mouseX, y: mouseY } = lastPosition.current;
          // The previous tween must release this element before another starts.
          glowAnimation.current?.stop();
          glowAnimation.current = null;

          const center = [left + width * 0.5, top + height * 0.5];
          const distanceFromCenter = Math.hypot(
            mouseX - center[0],
            mouseY - center[1]
          );
          const inactiveRadius = 0.5 * Math.min(width, height) * inactiveZone;

          if (distanceFromCenter < inactiveRadius) {
            element.style.setProperty("--active", "0");
            return;
          }

          const isActive =
            mouseX > left - proximity &&
            mouseX < left + width + proximity &&
            mouseY > top - proximity &&
            mouseY < top + height + proximity;

          element.style.setProperty("--active", isActive ? "1" : "0");

          if (!isActive) return;

          const currentAngle =
            parseFloat(element.style.getPropertyValue("--start")) || 0;
          let targetAngle =
            (180 * Math.atan2(mouseY - center[1], mouseX - center[0])) /
              Math.PI +
            90;

          const angleDiff = ((targetAngle - currentAngle + 180) % 360) - 180;
          const newAngle = currentAngle + angleDiff;

          glowAnimation.current = animate(currentAngle, newAngle, {
            duration: movementDuration,
            ease: [0.16, 1, 0.3, 1],
            onUpdate: (value) => {
              element.style.setProperty("--start", String(value));
            },
          });
        });
      },
      [inactiveZone, proximity, movementDuration]
    );

    useEffect(() => {
      if (!followsPointer) return;

      const handleScroll = () => handleMove();
      const handlePointerMove = (e: PointerEvent) => handleMove(e);
      let listening = false;
      const setListening = (visible: boolean) => {
        if (visible === listening) return;
        listening = visible;
        if (visible) {
          window.addEventListener("scroll", handleScroll, { passive: true });
          document.body.addEventListener("pointermove", handlePointerMove, { passive: true });
        } else {
          window.removeEventListener("scroll", handleScroll);
          document.body.removeEventListener("pointermove", handlePointerMove);
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = 0;
          glowAnimation.current?.stop();
          glowAnimation.current = null;
          containerRef.current?.style.setProperty("--active", "0");
        }
      };
      // Offscreen cards need no pointer listeners, layout reads or glow tweens.
      const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(
        ([entry]) => setListening(entry.isIntersecting),
        { rootMargin: `${proximity}px` }
      );
      if (observer && containerRef.current) observer.observe(containerRef.current);
      else setListening(true);

      return () => {
        observer?.disconnect();
        setListening(false);
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = 0;
        }
        glowAnimation.current?.stop();
        glowAnimation.current = null;
      };
    }, [handleMove, followsPointer, proximity]);

    return (
      <>
        <div
          data-glow-edge
          style={{ "--glow-color": color } as React.CSSProperties}
          className={cn(
            "pointer-events-none absolute -inset-px overflow-hidden rounded-[inherit] border-2",
            glow ? "block" : "hidden",
            variant === "white" ? "border-white" : "border-[color-mix(in_oklab,var(--glow-color)_80%,transparent)]"
          )}
        >
          {variant !== "white" && <span data-glow-bar className="absolute inset-y-0 left-0 w-1 bg-[var(--glow-color)]" />}
        </div>
        <div
          ref={containerRef}
          style={
            {
              "--glow-color": color,
              "--blur": `${blur}px`,
              "--spread": spread,
              "--start": "0",
              "--active": "0",
              "--glowingeffect-border-width": `${borderWidth}px`,
              "--repeating-conic-gradient-times": "5",
              "--gradient":
                variant === "white"
                  ? `repeating-conic-gradient(
                  from 236.84deg at 50% 50%,
                  var(--black),
                  var(--black) calc(25% / var(--repeating-conic-gradient-times))
                )`
                  : "linear-gradient(var(--glow-color), var(--glow-color))",
            } as React.CSSProperties
          }
          className={cn(
            "pointer-events-none absolute inset-0 rounded-[inherit] opacity-100 transition-opacity",
            blur > 0 && "blur-[var(--blur)] ",
            className,
            !followsPointer && "hidden"
          )}
        >
          <div
            className={cn(
              "glow",
              "rounded-[inherit]",
              'after:content-[""] after:rounded-[inherit] after:absolute after:inset-[calc(-1*var(--glowingeffect-border-width))]',
              "after:[border:var(--glowingeffect-border-width)_solid_transparent]",
              "after:[background:var(--gradient)] after:[background-attachment:fixed]",
              "after:opacity-[var(--active)] after:transition-opacity after:duration-300",
              "after:[mask-clip:padding-box,border-box]",
              "after:[mask-composite:intersect]",
              "after:[mask-image:linear-gradient(transparent,transparent),conic-gradient(from_calc((var(--start)-var(--spread))*1deg),transparent_0deg,white,transparent_calc(var(--spread)*2deg))]"
            )}
          />
        </div>
      </>
    );
  }
);

GlowingEffect.displayName = "GlowingEffect";

export { GlowingEffect };
