/**
 * Renders claude-mem observations as gbrain markdown pages.
 *
 * One renderer shared by both write lanes (live `gbrain capture --stdin` and
 * bulk `gbrain import <dir>`): YAML frontmatter + the observation body layout
 * copied from CorpusRenderer.renderObservation.
 *
 * Slug discipline: gbrain derives import slugs from the file path relative to
 * the import root (gbrain src/core/import-file.ts — `slugifyPath(relativePath)`
 * is authoritative; frontmatter `slug:` is only accepted when it matches). So
 * `observationSlug()` output doubles as the staging-relative file path
 * (`<slug>.md`), and its segments are sanitized to survive gbrain's
 * `slugifySegment` unchanged — capture lane and import lane always mint the
 * SAME slug for the same observation.
 */

export interface GbrainObservationSource {
  id: number;
  project: string;
  memorySessionId: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string[];
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
  createdAtEpoch: number;
}

/**
 * Sanitize one slug segment to gbrain's slug alphabet (mirror of gbrain's
 * `slugifySegment`: lowercase, keep alnum/dot/underscore/hyphen, spaces and
 * everything else collapse to hyphens). Output must be a fixed point of
 * gbrain's own slugifier so path-derived import slugs match capture slugs.
 */
function sanitizeSlugSegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

export function observationSlug(prefix: string, project: string, id: number): string {
  const segments = [
    ...prefix.split('/'),
    ...project.split('/'),
  ]
    .map(sanitizeSlugSegment)
    .filter(segment => segment.length > 0);
  segments.push(`obs-${id}`);
  return segments.join('/');
}

/** Single-quoted YAML scalar (newlines flattened — titles/subtitles are single-line). */
function yamlQuote(value: string): string {
  return `'${value.replace(/\r?\n/g, ' ').replace(/'/g, "''")}'`;
}

function yamlStringList(values: string[]): string {
  return `[${values.map(yamlQuote).join(', ')}]`;
}

export function renderObservationMarkdown(obs: GbrainObservationSource): string {
  const lines: string[] = [];
  const title = obs.title || 'Untitled';
  const createdAtIso = new Date(obs.createdAtEpoch).toISOString();

  lines.push('---');
  lines.push('type: note');
  lines.push(`title: ${yamlQuote(title)}`);
  if (obs.concepts.length > 0) {
    lines.push(`tags: ${yamlStringList(obs.concepts)}`);
  }
  lines.push('claude_mem:');
  lines.push(`  observation_id: ${obs.id}`);
  lines.push(`  project: ${yamlQuote(obs.project)}`);
  lines.push(`  obs_type: ${yamlQuote(obs.type)}`);
  lines.push(`  memory_session_id: ${yamlQuote(obs.memorySessionId)}`);
  lines.push(`  created_at: ${yamlQuote(createdAtIso)}`);
  if (obs.filesRead.length > 0) {
    lines.push(`  files_read: ${yamlStringList(obs.filesRead)}`);
  }
  if (obs.filesModified.length > 0) {
    lines.push(`  files_modified: ${yamlStringList(obs.filesModified)}`);
  }
  lines.push('---');
  lines.push('');

  // Body layout copied from CorpusRenderer.renderObservation (CorpusRenderer.ts:27-68).
  const dateStr = createdAtIso.split('T')[0];
  lines.push(`## [${obs.type.toUpperCase()}] ${title}`);
  lines.push(`*${dateStr}* | Project: ${obs.project}`);

  if (obs.subtitle) {
    lines.push(`> ${obs.subtitle}`);
  }

  lines.push('');

  if (obs.narrative) {
    lines.push(obs.narrative);
    lines.push('');
  }

  if (obs.facts.length > 0) {
    lines.push('**Facts:**');
    for (const fact of obs.facts) {
      lines.push(`- ${fact}`);
    }
    lines.push('');
  }

  if (obs.concepts.length > 0) {
    lines.push(`**Concepts:** ${obs.concepts.join(', ')}`);
  }

  if (obs.filesRead.length > 0) {
    lines.push(`**Files Read:** ${obs.filesRead.join(', ')}`);
  }
  if (obs.filesModified.length > 0) {
    lines.push(`**Files Modified:** ${obs.filesModified.join(', ')}`);
  }

  lines.push('');
  return lines.join('\n');
}
