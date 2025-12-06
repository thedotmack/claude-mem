import { ObservationSearchResult } from '../../../services/sqlite/types.js';

/**
 * Format observation as index entry (title, date, ID only)
 */
export function formatObservationIndex(obs: ObservationSearchResult, index: number): string {
  const title = obs.title || `Observation #${obs.id}`;
  const date = new Date(obs.created_at_epoch).toLocaleString();
  const type = obs.type ? `[${obs.type}]` : '';

  return `${index + 1}. ${type} ${title}
   Date: ${date}
   Source: claude-mem://observation/${obs.id}`;
}

/**
 * Format observation as text content with metadata
 */
export function formatObservationResult(obs: ObservationSearchResult): string {
  const title = obs.title || `Observation #${obs.id}`;

  // Build content from available fields
  const contentParts: string[] = [];
  contentParts.push(`## ${title}`);
  contentParts.push(`*Source: claude-mem://observation/${obs.id}*`);
  contentParts.push('');

  if (obs.subtitle) {
    contentParts.push(`**${obs.subtitle}**`);
    contentParts.push('');
  }

  if (obs.narrative) {
    contentParts.push(obs.narrative);
    contentParts.push('');
  }

  if (obs.text) {
    contentParts.push(obs.text);
    contentParts.push('');
  }

  // Add metadata
  const metadata: string[] = [];
  metadata.push(`Type: ${obs.type}`);

  if (obs.facts) {
    try {
      const facts = JSON.parse(obs.facts);
      if (facts.length > 0) {
        metadata.push(`Facts: ${facts.join('; ')}`);
      }
    } catch {}
  }

  if (obs.concepts) {
    try {
      const concepts = JSON.parse(obs.concepts);
      if (concepts.length > 0) {
        metadata.push(`Concepts: ${concepts.join(', ')}`);
      }
    } catch {}
  }

  if (obs.files_read || obs.files_modified) {
    const files: string[] = [];
    if (obs.files_read) {
      try {
        files.push(...JSON.parse(obs.files_read));
      } catch {}
    }
    if (obs.files_modified) {
      try {
        files.push(...JSON.parse(obs.files_modified));
      } catch {}
    }
    if (files.length > 0) {
      metadata.push(`Files: ${[...new Set(files)].join(', ')}`);
    }
  }

  if (metadata.length > 0) {
    contentParts.push('---');
    contentParts.push(metadata.join(' | '));
  }

  // Add date
  const date = new Date(obs.created_at_epoch).toLocaleString();
  contentParts.push('');
  contentParts.push(`---`);
  contentParts.push(`Date: ${date}`);

  return contentParts.join('\n');
}
