import React, { type SVGProps, useRef, useState } from "react";
import { motion, useMotionValueEvent, useReducedMotion, useScroll } from "motion/react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { tabStopAfter } from "@/lib/tab-order";
import { buttonVariants } from "@/components/ui/button";

export const StickyBanner = ({
  className,
  children,
  hideOnScroll = false,
}: {
  className?: string;
  children: React.ReactNode;
  hideOnScroll?: boolean;
}) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  // Local fix (c-shell-sticky-banner F state-preservation): closed with its button, the strip stays closed. Before,
  // scrolling back to the top opened it again whatever was pressed.
  const [dismissed, setDismissed] = useState(false);
  const bannerRef = useRef<HTMLDivElement>(null);
  // Local fix (plan rule 8): under reduced motion the strip and its close button appear, slide and fade at once.
  const reduceMotion = useReducedMotion();
  const { scrollY } = useScroll();

  useMotionValueEvent(scrollY, "change", (latest) => {
    // 40px: about the strip's own height, so it slides away once the page has scrolled past it.
    if (hideOnScroll && latest > 40) {
      setOpen(false);
    } else {
      setOpen(true);
    }
  });

  // Local fix: closing it from the keyboard moves focus on to where Tab would have gone next (the header), instead of
  // dropping it on the page body when the strip leaves the page.
  const dismiss = () => {
    const banner = bannerRef.current;
    if (banner?.contains(document.activeElement)) tabStopAfter(banner)?.focus();
    setDismissed(true);
  };

  if (dismissed) return null;

  return (
    <motion.div
      ref={bannerRef}
      // Local fix: while slid away its controls leave the Tab order, so focus never lands on something off screen.
      inert={!open}
      className={cn(
        "sticky inset-x-0 top-0 z-40 flex min-h-14 w-full items-center justify-center bg-transparent px-4 py-1",
        className,
      )}
      initial={reduceMotion ? false : {
        y: -100,
        opacity: 0,
      }}
      animate={{
        y: open ? 0 : -100,
        opacity: open ? 1 : 0,
      }}
      transition={reduceMotion ? { duration: 0 } : {
        duration: 0.3,
        ease: "easeInOut",
      }}
    >
      {children}

      <motion.button
        initial={reduceMotion ? false : {
          scale: 0,
        }}
        animate={{
          scale: 1,
        }}
        transition={reduceMotion ? { duration: 0 } : undefined}
        // Local fix: labelled, thumb-sized (the Button's own touch rule), the Button's focus ring and cursor, and in
        // the text color (white was invisible on light surfaces). Centred with margins, not a transform, so the
        // Button's press nudge does not move it.
        type="button"
        aria-label={t('Hide banner')}
        className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "absolute inset-y-0 right-1 my-auto size-8 rounded-lg text-muted-foreground")}
        onClick={dismiss}
      >
        <CloseIcon className="size-5" />
      </motion.button>
    </motion.div>
  );
};

const CloseIcon = (props: SVGProps<SVGSVGElement>) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path stroke="none" d="M0 0h24v24H0z" fill="none" />
      <path d="M18 6l-12 12" />
      <path d="M6 6l12 12" />
    </svg>
  );
};
