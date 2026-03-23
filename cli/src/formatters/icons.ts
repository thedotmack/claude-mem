/**
 * Observation type icons — matches the memory worker's legend.
 */

const TYPE_ICONS: Record<string, string> = {
  decision: '\u26d6',
  bugfix: '\ud83d\udfe1',
  feature: '\ud83d\udfe2',
  discovery: '\ud83d\udfe3',
  change: '\ud83d\udfe2',
  refactor: '\ud83d\udd35',
  'how-it-works': '\ud83d\udd35',
  gotcha: '\ud83d\udd34',
  'trade-off': '\u2696\ufe0f',
  'session-request': '\ud83c\udfaf',
};

export function getTypeIcon(type: string): string {
  return TYPE_ICONS[type] || '\u25cb';
}

export function getTypeName(type: string): string {
  return type.replace(/-/g, ' ');
}
