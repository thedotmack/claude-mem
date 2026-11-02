// The one rule for "an area name reuses a nav word", shared by the worker (seed, rename, system suggestions) and the
// My Work UI (rename dialog, area header). No imports, so the browser bundle can load it.
//
// The nav labels: MY FOCUS, My Work, My Rules, Other, Suggested, Past focus, and the rail's section labels Monitor and
// Steer. A name reuses one when the label appears in it as whole words, case-insensitively: "Other things" and
// "Ship the My Work viewer" do, while "Work viewer", "Network" and "My laptop" do not. Whole-label matching keeps
// ordinary names (with "work", "my" or "focus" in them) usable; only a name that would read as a nav item is refused.
export const NAV_LABELS = Object.freeze(['my focus', 'my work', 'my rules', 'other', 'suggested', 'past focus', 'monitor', 'steer']);

/** The nav label a name reuses, lowercase, or null. */
export function navWordIn(name) {
  const words = ` ${String(name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ')} `;
  return NAV_LABELS.find((label) => words.includes(` ${label} `)) ?? null;
}
