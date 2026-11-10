/**
 * Project keys travel as a list, and as text in a query string. A checkout's
 * key can carry commas and outer whitespace (`topic ` is not `topic`), but a
 * person typing `api, web` means two projects. The forms meet here:
 *
 * - a list entry, a JSON list, or a lone key with no comma is exact;
 * - text with a comma is a typed list, so its entries are trimmed.
 *
 * Express returns one `projects=` value as a string. A JSON list preserves
 * exact entries in that case, including a single key that contains a comma.
 */
export function parseProjectList(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every(entry => typeof entry === 'string')) value = parsed;
    } catch { /* Plain project text or a hand-typed comma list. */ }
  }
  const entries: unknown[] = Array.isArray(value) ? value
    : typeof value === 'string' && value.includes(',') ? value.split(',').map(project => project.trim())
    : [value];
  return entries
    .filter((entry): entry is string => typeof entry === 'string')
    .filter(project => project.trim().length > 0);
}

/**
 * The `projects` query values for exact keys: JSON when a key contains a comma
 * or could be mistaken for JSON, otherwise the existing comma/repeated forms.
 */
export function projectsQueryValues(projects: readonly string[]): string[] {
  if (projects.some(project => project.includes(',') || project.trimStart().startsWith('['))) {
    return [JSON.stringify(projects)];
  }
  return projects.every(project => project === project.trim()) ? [projects.join(',')] : [...projects];
}

/** `projects=...` for a hand-built URL, encoded. */
export function projectsQueryString(projects: readonly string[]): string {
  return projectsQueryValues(projects).map(value => `projects=${encodeURIComponent(value)}`).join('&');
}
