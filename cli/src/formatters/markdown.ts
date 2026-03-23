/**
 * Markdown output formatter — for piping to files or docs.
 */

import type { Observation, SearchResult } from '../types.js';

export function observationToMarkdown(obs: Observation): string {
  const lines: string[] = [];
  lines.push(`## #${obs.id} ${obs.title}`);
  if (obs.subtitle) lines.push(`*${obs.subtitle}*`);
  lines.push(`- Type: ${obs.type}`);
  lines.push(`- Project: ${obs.project || 'none'}`);
  lines.push(`- Date: ${new Date(obs.created_at_epoch).toISOString()}`);

  if (obs.narrative) {
    lines.push('');
    lines.push(obs.narrative);
  }

  if (obs.facts && obs.facts.length > 0) {
    lines.push('');
    lines.push('### Facts');
    for (const fact of obs.facts) {
      lines.push(`- ${fact}`);
    }
  }

  if (obs.files_modified && obs.files_modified.length > 0) {
    lines.push('');
    lines.push(`**Files:** ${obs.files_modified.join(', ')}`);
  }

  return lines.join('\n');
}

export function searchResultsToMarkdown(results: SearchResult[]): string {
  const lines: string[] = [];
  lines.push('| ID | Type | Title |');
  lines.push('|-----|------|-------|');
  for (const r of results) {
    lines.push(`| ${r.id} | ${r.type} | ${r.title} |`);
  }
  return lines.join('\n');
}
