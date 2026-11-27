/**
 * True when `url` is an http(s) URL we are willing to hand to an OS opener.
 *
 * The installer only ever opens pages it printed for the user, but the value
 * can come from a server response or a redirect. Restricting the scheme keeps
 * `javascript:`, `file:`, and `data:` URLs out of the platform opener, and the
 * callers pass the result as a single argv entry so the URL is never re-parsed
 * as a shell command.
 */
export function isSafeBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}