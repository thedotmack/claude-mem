/**
 * One save button's looks, read in the page (components/aceternity/stateful-button.tsx), for the browser tests that
 * check every save button the request card and the drawer draw (fix round V12: one width in every look, with the icon
 * slot reserved and never an empty gap at rest).
 *
 * Every state's words sit in one grid cell, hidden unless that state shows, so the widest of them sets the button's one
 * width. For each state's cell this reads: whether it shows, the mark at the icon slot's place (the reserved slot, or the
 * caller's own icon at the start of its label when the empty slot steps aside for it), whether that mark draws an icon,
 * and the width of the cell's content as laid out. `button` is a page expression for the button.
 */
export function saveButtonLooks(button: string): string {
  return `(() => {
    const button = ${button};
    const round = (value) => Math.round(value * 100) / 100;
    const cells = Object.fromEntries([...button.querySelectorAll('[data-stateful-label]')].map((cell) => {
      const slot = cell.querySelector(':scope > [data-icon-slot]');
      const mark = slot && getComputedStyle(slot).display !== 'none' ? slot : cell.querySelector(':scope > svg');
      const content = document.createRange();
      content.selectNodeContents(cell);
      return [cell.dataset.statefulLabel, { shows: !cell.classList.contains('invisible'), markInSlot: mark !== null && mark === slot,
        drawsIcon: mark !== null && (mark.matches('svg') || mark.querySelector('svg') !== null), contentWidth: round(content.getBoundingClientRect().width) }];
    }));
    return { state: button.dataset.saveState, width: round(button.getBoundingClientRect().width), cells };
  })()`;
}

/** What saveButtonLooks reads. */
export interface SaveButtonLook {
  state: string;
  width: number;
  cells: Record<string, { shows: boolean; markInSlot: boolean; drawsIcon: boolean; contentWidth: number }>;
}
