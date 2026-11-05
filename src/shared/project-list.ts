/**
 * Project keys travel as a list, and as text in a query string. A checkout's
 * key can carry outer whitespace (`topic ` is not `topic`), but a person typing
 * `api, web` means `web`. The two meet here:
 *
 * - a list entry, or a lone key with no comma, is exact;
 * - text with a comma is a typed list, so its entries are trimmed.
 *
 * A lone key must stay exact because Express hands one `projects=` value to the
 * route as a string, whichever form the caller meant. Names containing commas
 * are not representable in either form.
 */
export function parseProjectList(value: unknown): string[] {
  const entries: unknown[] = Array.isArray(value) ? value : [value];
  return entries
    .filter((entry): entry is string => typeof entry === 'string')
    .flatMap(entry => entry.includes(',') ? entry.split(',').map(project => project.trim()) : [entry])
    .filter(project => project.trim().length > 0);
}

/**
 * The `projects` query values for a list of exact keys: the usual one comma
 * list, or the key repeated once per project when a comma list's trimming would
 * change one of them.
 */
export function projectsQueryValues(projects: readonly string[]): string[] {
  return projects.every(project => project === project.trim()) ? [projects.join(',')] : [...projects];
}

/** `projects=...` for a hand-built URL, encoded. */
export function projectsQueryString(projects: readonly string[]): string {
  return projectsQueryValues(projects).map(value => `projects=${encodeURIComponent(value)}`).join('&');
}
