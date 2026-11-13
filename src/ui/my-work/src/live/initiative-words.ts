// What the page calls the heading the owner files focuses under: a Project. The code calls it an initiative, because
// in the worker `project` already means the folder a request ran in, and the two must not be confused. The word lives
// here and in one block of each catalog (src/ui/i18n/mywork-*.ts), so calling it something else is a change to these lines.
export const INITIATIVE_WORDS = {
  name: 'Project',
  none: 'No project',
  add: 'New project…',
  move: 'Move to project',
  /** Beside a heading nobody chose: its name is only the folder the work ran in. */
  guess: 'guess',
  moved: 'Moved “{name}” under “{initiative}”',
  unfiled: 'Filed “{names}” under no project',
  filed: 'Filed {count} focuses under “{initiative}”',
  /** The heading's own menu, and its grip. */
  actions: 'Project actions: {name}',
  mergeInto: 'Merge into',
  drag: 'Drag onto another project to merge into it',
} as const
