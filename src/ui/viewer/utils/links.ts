/**
 * A plain left click on one of the viewer's own links (a Sessions row, "Back to sessions", a breadcrumb), which the
 * viewer follows in place; a modified or middle click keeps the link's own behaviour (a new tab or window).
 */
export function isPlainClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
