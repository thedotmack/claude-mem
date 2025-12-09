/**
 * Format observation as markdown for context injection
 */
export function formatObservationAsMarkdown(observation: {
  type: string;
  title: string;
  subtitle?: string;
  narrative?: string;
  concepts?: string[];
  files_read?: string[];
  files_modified?: string[];
}): string {
  const typeEmoji = {
    discovery: '🔵',
    bugfix: '🔴',
    feature: '🟣',
    refactor: '🔄',
    decision: '⚖️'
  }[observation.type] || '✅';

  let markdown = `<claude-mem-context>\n`;
  markdown += `## ${typeEmoji} ${observation.title}\n\n`;

  if (observation.subtitle) {
    markdown += `**${observation.subtitle}**\n\n`;
  }

  if (observation.narrative) {
    markdown += `${observation.narrative}\n\n`;
  }

  if (observation.concepts && observation.concepts.length > 0) {
    markdown += `**Key concepts**: ${observation.concepts.join(', ')}\n\n`;
  }

  if (observation.files_read && observation.files_read.length > 0) {
    markdown += `**Files analyzed**: ${observation.files_read.join(', ')}\n\n`;
  }

  if (observation.files_modified && observation.files_modified.length > 0) {
    markdown += `**Files modified**: ${observation.files_modified.join(', ')}\n\n`;
  }

  markdown += `</claude-mem-context>`;

  return markdown;
}
