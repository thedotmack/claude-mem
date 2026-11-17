import { cn } from "@/lib/utils";
import React, { useRef, useState, useEffect } from "react";
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  animate,
  useVelocity,
  useAnimationControls,
  useReducedMotion,
} from "motion/react";

/**
 * Local addition (c-aceternity-draggable-card M3): a card that decides on release stays on screen. It follows the
 * finger at half speed inside zero constraints, so a 96px decide swipe moves it about 48px and a long one never
 * pushes its buttons past the screen edge (they were cut off at 390px). Free cards keep the demo's half-window range.
 */
export const DECIDE_DRAG_ELASTIC = 0.5;

export const DraggableCardBody = ({
  className,
  children,
  dragAxis,
  onDragRelease,
  onDragMove,
  disabled = false,
}: {
  className?: string;
  children?: React.ReactNode;
  /** Local addition: lock dragging to one axis ("x" keeps vertical page scroll on touch screens). Free drag when unset. */
  dragAxis?: "x" | "y";
  /** Local addition: called on release with how far the card moved from where the drag started; the card springs back. */
  onDragRelease?: (offset: { x: number; y: number }) => void;
  /** Local addition: called while dragging with how far the finger moved, so the caller can show what letting go does. */
  onDragMove?: (offset: { x: number; y: number }) => void;
  /** Local addition: the card does not drag (a save is in flight, so a swipe would be refused). */
  disabled?: boolean;
}) => {
  // Local fix (plan rule 8), checked here and not only by MotionConfig: under reduced motion nothing on the card
  // animates. No tilt, fade, glare or hover zoom; a deciding card stays in place while dragged (no elastic pull, no
  // momentum, no spring back on release), while the caller shows what letting go does; a free card is not thrown.
  const reduceMotion = useReducedMotion() ?? false;
  const decides = onDragRelease !== undefined;
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const controls = useAnimationControls();
  const [constraints, setConstraints] = useState({
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  });

  // physics biatch
  const velocityX = useVelocity(mouseX);
  const velocityY = useVelocity(mouseY);

  const springConfig = {
    stiffness: 100,
    damping: 20,
    mass: 0.5,
  };

  const rotateX = useSpring(
    useTransform(mouseY, [-300, 300], [25, -25]),
    springConfig,
  );
  const rotateY = useSpring(
    useTransform(mouseX, [-300, 300], [-25, 25]),
    springConfig,
  );

  const opacity = useSpring(
    useTransform(mouseX, [-300, 0, 300], [0.8, 1, 0.8]),
    springConfig,
  );

  const glareOpacity = useSpring(
    useTransform(mouseX, [-300, 0, 300], [0.2, 0, 0.2]),
    springConfig,
  );

  useEffect(() => {
    // Update constraints when component mounts or window resizes
    const updateConstraints = () => {
      if (typeof window !== "undefined") {
        setConstraints({
          top: -window.innerHeight / 2,
          left: -window.innerWidth / 2,
          right: window.innerWidth / 2,
          bottom: window.innerHeight / 2,
        });
      }
    };

    updateConstraints();

    // Add resize listener
    window.addEventListener("resize", updateConstraints);

    // Clean up
    return () => {
      window.removeEventListener("resize", updateConstraints);
    };
  }, []);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const { clientX, clientY } = e;
    const { width, height, left, top } =
      cardRef.current?.getBoundingClientRect() ?? {
        width: 0,
        height: 0,
        left: 0,
        top: 0,
      };
    const centerX = left + width / 2;
    const centerY = top + height / 2;
    const deltaX = clientX - centerX;
    const deltaY = clientY - centerY;
    mouseX.set(deltaX);
    mouseY.set(deltaY);
  };

  const handleMouseLeave = () => {
    mouseX.set(0);
    mouseY.set(0);
  };

  return (
    <motion.div
      ref={cardRef}
      drag={disabled ? false : (dragAxis ?? true)}
      dragConstraints={decides ? { top: 0, left: 0, right: 0, bottom: 0 } : constraints}
      dragElastic={decides ? (reduceMotion ? 0 : DECIDE_DRAG_ELASTIC) : undefined}
      dragMomentum={!reduceMotion}
      dragSnapToOrigin={decides && !reduceMotion}
      onDrag={(_event, info) => onDragMove?.(info.offset)}
      onDragStart={() => {
        document.body.style.cursor = "grabbing";
      }}
      onDragEnd={(_event, info) => {
        document.body.style.cursor = "default";
        onDragMove?.({ x: 0, y: 0 });
        onDragRelease?.(info.offset);
        // The tilt reset and the throw below are animations.
        if (reduceMotion) return;

        controls.start({
          rotateX: 0,
          rotateY: 0,
          transition: {
            type: "spring",
            ...springConfig,
          },
        });
        const currentVelocityX = velocityX.get();
        const currentVelocityY = velocityY.get();

        const velocityMagnitude = Math.sqrt(
          currentVelocityX * currentVelocityX +
            currentVelocityY * currentVelocityY,
        );
        const bounce = Math.min(0.8, velocityMagnitude / 1000);

        animate(info.point.x, info.point.x + currentVelocityX * 0.3, {
          duration: 0.8,
          ease: [0.2, 0, 0, 1],
          bounce,
          type: "spring",
          stiffness: 50,
          damping: 15,
          mass: 0.8,
        });

        animate(info.point.y, info.point.y + currentVelocityY * 0.3, {
          duration: 0.8,
          ease: [0.2, 0, 0, 1],
          bounce,
          type: "spring",
          stiffness: 50,
          damping: 15,
          mass: 0.8,
        });
      }}
      style={reduceMotion ? { willChange: "transform" } : {
        rotateX,
        rotateY,
        opacity,
        willChange: "transform",
      }}
      animate={controls}
      whileHover={reduceMotion ? undefined : { scale: 1.02 }}
      onMouseMove={reduceMotion ? undefined : handleMouseMove}
      onMouseLeave={reduceMotion ? undefined : handleMouseLeave}
      className={cn(
        "relative min-h-96 w-80 overflow-hidden rounded-md bg-neutral-100 p-6 shadow-2xl transform-3d dark:bg-neutral-900",
        className,
      )}
    >
      {children}
      {!reduceMotion && <motion.div
        style={{
          opacity: glareOpacity,
        }}
        className="pointer-events-none absolute inset-0 bg-white select-none"
      />}
    </motion.div>
  );
};

export const DraggableCardContainer = ({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) => {
  return (
    <div className={cn("[perspective:3000px]", className)}>{children}</div>
  );
};
