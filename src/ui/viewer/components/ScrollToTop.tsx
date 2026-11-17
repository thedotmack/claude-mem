import React, { useState, useEffect } from 'react';
import { useI18n } from '../../i18n';
import { ArrowUpIcon } from './icons';

interface ScrollToTopProps {
  targetRef: React.RefObject<HTMLDivElement | null>;
  /** Scrolls the list to its start; a windowed list passes its own, which stays on course while rows are measured. */
  onTop?: () => void;
}

// The page heading and filter bar are about 300px tall at 1440; past that the top of the list is out of view.
const SHOW_AFTER_PX = 300;

/** Smooth, unless the reader asked the system for reduced motion. */
export function scrollBehaviorForReader(): ScrollBehavior {
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reduce ? 'auto' : 'smooth';
}

/** Scrolls without animation when the reader asked the system for reduced motion. */
export function scrollToStart(target: HTMLElement): void {
  target.scrollTo({ top: 0, behavior: scrollBehaviorForReader() });
}

/** A neutral round button, the twin of the logs button: the position itself is in the bar pinned over the list. */
export function ScrollToTop({ targetRef, onTop }: ScrollToTopProps) {
  const { t } = useI18n();
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    const handleScroll = () => setIsVisible(target.scrollTop > SHOW_AFTER_PX);
    target.addEventListener('scroll', handleScroll, { passive: true });
    return () => target.removeEventListener('scroll', handleScroll);
  }, [targetRef]);

  if (!isVisible) return null;

  return (
    <button
      type="button"
      onClick={() => {
        if (onTop) onTop();
        else if (targetRef.current) scrollToStart(targetRef.current);
      }}
      className="scroll-to-top"
      aria-label={t('Scroll to top')}
      title={t('Scroll to top')}
    >
      <ArrowUpIcon size={20} />
    </button>
  );
}
