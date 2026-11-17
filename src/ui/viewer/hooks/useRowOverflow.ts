import { useCallback, useState } from 'react';

export interface RowOverflow { before: boolean; after: boolean }

/**
 * Whether a sideways-scrolling row runs past its start or end edge. A row whose scrollbar is hidden (the kind chips
 * and the logs drawer's chip rows on a phone, the Settings section tabs at 1100px and below) fades out at the cut edge
 * instead (.scroll-more-before and .scroll-more-after in viewer-template.html), so it still shows that more is there
 * to swipe or tab to. Give `rowRef` to the row and add `className` to its classes. The row's children are watched as
 * well as the row: words or counts that change width (a language switch, a count that gains a digit) and items that
 * come or go move the edges without resizing the row itself.
 */
export function useRowOverflow() {
  const [overflow, setOverflow] = useState<RowOverflow>({ before: false, after: false });
  const rowRef = useCallback((row: HTMLElement | null) => {
    if (!row) return;
    const update = () => {
      const before = row.scrollLeft > 1;
      const after = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
      setOverflow(previous => previous.before === before && previous.after === after ? previous : { before, after });
    };
    const resizes = new ResizeObserver(update);
    const watchChildren = () => { resizes.observe(row); for (const child of row.children) resizes.observe(child); };
    watchChildren();
    const children = new MutationObserver(() => { watchChildren(); update(); });
    children.observe(row, { childList: true });
    row.addEventListener('scroll', update, { passive: true });
    update();
    return () => {
      resizes.disconnect();
      children.disconnect();
      row.removeEventListener('scroll', update);
    };
  }, []);
  const className = `${overflow.before ? ' scroll-more-before' : ''}${overflow.after ? ' scroll-more-after' : ''}`;
  return { rowRef, overflow, className };
}
