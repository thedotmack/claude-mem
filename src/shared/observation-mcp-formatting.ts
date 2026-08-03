type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function metadataOf(observation: UnknownRecord): UnknownRecord {
  const metadata = observation.metadata;
  if (isRecord(metadata)) return metadata;
  if (typeof metadata !== 'string' || metadata.trim().length === 0) return {};

  try {
    const parsed = JSON.parse(metadata);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstValue(observation: UnknownRecord, metadata: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    const direct = observation[key];
    if (direct !== undefined && direct !== null && direct !== '') return direct;
    const nested = metadata[key];
    if (nested !== undefined && nested !== null && nested !== '') return nested;
  }
  return undefined;
}

function stringValue(observation: UnknownRecord, metadata: UnknownRecord, ...keys: string[]): string {
  const value = firstValue(observation, metadata, ...keys);
  return typeof value === 'string' ? value.trim() : '';
}

function scalarValue(observation: UnknownRecord, metadata: UnknownRecord, ...keys: string[]): string {
  const value = firstValue(observation, metadata, ...keys);
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function listValue(observation: UnknownRecord, metadata: UnknownRecord, ...keys: string[]): string[] {
  const value = firstValue(observation, metadata, ...keys);
  let values: unknown[];

  if (Array.isArray(value)) {
    values = value;
  } else if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value);
      values = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'string'
          ? [parsed]
          : [];
    } catch {
      values = [value];
    }
  } else {
    values = [];
  }

  return [...new Set(values
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean))];
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function inlineCode(value: string): string {
  return value.includes('`') ? `\`\` ${value} \`\`` : `\`${value}\``;
}

function formatTimestamp(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';

  let timestamp: string | number = value as string | number;
  if (typeof timestamp === 'number' && timestamp > 0 && timestamp < 1_000_000_000_000) {
    timestamp *= 1000;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

function observationArray(payload: unknown): UnknownRecord[] {
  const values = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.observations)
      ? payload.observations
      : [];

  return values.filter(isRecord);
}

function observationContent(observation: UnknownRecord, metadata: UnknownRecord): {
  title: string;
  subtitle: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
} {
  const title = stringValue(observation, metadata, 'title');
  const subtitle = stringValue(observation, metadata, 'subtitle');
  const structuredNarrative = stringValue(observation, metadata, 'narrative');
  const facts = listValue(observation, metadata, 'facts');
  const concepts = listValue(observation, metadata, 'concepts');
  const filesRead = listValue(observation, metadata, 'files_read', 'filesRead');
  const filesModified = listValue(observation, metadata, 'files_modified', 'filesModified');

  // Server observations carry a rendered `content` field as well as structured
  // title/narrative/facts metadata. Prefer the structured fields so MCP output
  // does not repeat the same observation twice. Old worker rows fall back to
  // `text`; manual server observations fall back to `content`.
  const fallbackContent = stringValue(observation, metadata, 'content', 'text');
  const structuredPieces = [title, subtitle, ...facts].filter(Boolean);
  const fallbackOnlyRepeatsStructuredFields = Boolean(fallbackContent && structuredPieces.length > 0)
    && structuredPieces.every(piece => fallbackContent.includes(piece));
  const narrative = structuredNarrative || (fallbackOnlyRepeatsStructuredFields ? '' : fallbackContent);

  return { title, subtitle, narrative, facts, concepts, filesRead, filesModified };
}

/**
 * Render full observation details for an MCP client without exposing the raw
 * persistence row. The input may be either an observation array or an object
 * with an `observations` array (the server REST response shape).
 */
export function formatObservationDetails(payload: unknown): string {
  const observations = observationArray(payload);
  if (observations.length === 0) return 'No observations found.';

  const projects = [...new Set(observations
    .map(observation => {
      const metadata = metadataOf(observation);
      return stringValue(observation, metadata, 'project', 'projectId');
    })
    .filter(Boolean))];
  const sharedProject = projects.length === 1 ? projects[0] : '';

  const lines: string[] = [
    `# ${observations.length} observation${observations.length === 1 ? '' : 's'}${sharedProject ? ` · ${inlineCode(sharedProject)}` : ''}`,
    '',
  ];

  observations.forEach((observation, index) => {
    const metadata = metadataOf(observation);
    const id = scalarValue(observation, metadata, 'id') || '?';
    const type = stringValue(observation, metadata, 'type', 'kind');
    const project = stringValue(observation, metadata, 'project', 'projectId');
    const timestamp = formatTimestamp(firstValue(
      observation,
      metadata,
      'created_at_epoch',
      'createdAtEpoch',
      'created_at',
      'createdAt',
    ));
    const { title, subtitle, narrative, facts, concepts, filesRead, filesModified } = observationContent(observation, metadata);

    lines.push(`## #${oneLine(id)} — ${oneLine(title) || 'Untitled observation'}`);

    const meta = [
      type ? inlineCode(oneLine(type)) : '',
      timestamp,
      projects.length > 1 && project ? inlineCode(oneLine(project)) : '',
    ].filter(Boolean);
    if (meta.length > 0) lines.push(meta.join(' · '));
    if (subtitle) lines.push('', oneLine(subtitle));
    if (narrative) lines.push('', narrative);
    if (facts.length > 0) {
      lines.push('', ...facts.map(fact => `- ${oneLine(fact)}`));
    }
    if (concepts.length > 0) {
      lines.push('', `Concepts: ${concepts.map(oneLine).join(', ')}`);
    }
    if (filesModified.length > 0) {
      lines.push(`Modified: ${filesModified.map(file => inlineCode(oneLine(file))).join(', ')}`);
    }
    const modifiedSet = new Set(filesModified);
    const readOnly = filesRead.filter(file => !modifiedSet.has(file));
    if (readOnly.length > 0) {
      lines.push(`Read: ${readOnly.map(file => inlineCode(oneLine(file))).join(', ')}`);
    }

    if (index < observations.length - 1) lines.push('', '---', '');
  });

  return lines.join('\n').trim();
}

/** Render only the memory content for prompt injection, without JSON wrappers. */
export function formatObservationContext(payload: unknown): string {
  const blocks = observationArray(payload).map(observation => {
    const metadata = metadataOf(observation);
    const renderedContent = stringValue(observation, metadata, 'content');
    if (renderedContent) return renderedContent;

    const { title, subtitle, narrative, facts } = observationContent(observation, metadata);
    return [
      title,
      subtitle,
      narrative,
      facts.map(fact => `- ${oneLine(fact)}`).join('\n'),
    ].filter(Boolean).join('\n\n');
  }).filter(Boolean);

  return blocks.length > 0 ? blocks.join('\n\n---\n\n') : 'No observations found.';
}
