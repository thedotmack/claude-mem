// SPDX-License-Identifier: Apache-2.0

export interface ObservationContentFields {
  title?: string | null;
  subtitle?: string | null;
  text?: string | null;
  narrative?: string | null;
  facts?: string[] | string | null;
  concepts?: string[] | string | null;
}

export const NO_OP_OBSERVATION_TEXT_EXAMPLES = [
  'no durable observation to record',
  'no durable observations to record',
  'no observation to record',
  'no observations to record',
  'no observation to record for batch',
  'no observations to record for batch',
  'no observation to record for this batch',
  'no observations to record for this batch',
  'no observation to record for summary batch',
  'no observations to record for summary batch',
  'no observation to record for this summary batch',
  'no observations to record for this summary batch',
  'nothing durable to record',
  'nothing useful to record',
  'nothing material to record',
  'nothing substantive to record',
  'no substantive tool execution',
  'no substantive tool executions',
  'no substantive tool execution observed',
  'no substantive tool executions observed',
  'no tool usage observed in current session yet',
];

const NO_OP_OBSERVATION_TEXT_PATTERNS = [
  /^all routine verification commands\b.*\b(no debugging findings|no root cause analysis to record)\b/i,
];

export function normalizeObservationText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function observationArray(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map(normalizeObservationText).filter(Boolean);
  }

  const normalized = normalizeObservationText(value);
  if (!normalized) {
    return [];
  }

  if (normalized.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalized) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is string => typeof item === 'string')
          .map(normalizeObservationText)
          .filter(Boolean);
      }
    } catch {
      // Fall through and keep the raw value as one text item.
    }
  }

  return [normalized];
}

export function isNoOpObservationContent(fields: ObservationContentFields): boolean {
  const title = normalizeObservationText(fields.title);
  const subtitle = normalizeObservationText(fields.subtitle);
  const text = normalizeObservationText(fields.text);
  const narrative = normalizeObservationText(fields.narrative);
  const facts = observationArray(fields.facts);
  const concepts = observationArray(fields.concepts);

  if (facts.length > 0 || concepts.length > 0) {
    return false;
  }

  const contentParts = [title, subtitle, text, narrative].filter(Boolean);
  if (contentParts.length === 0) {
    return false;
  }

  return contentParts.every(isNoOpObservationText);
}

function isNoOpObservationText(value: string): boolean {
  const normalized = normalizeObservationText(value).toLowerCase();
  return (
    NO_OP_OBSERVATION_TEXT_EXAMPLES.some(example =>
      normalized === example || normalized === `${example}.`
    ) ||
    NO_OP_OBSERVATION_TEXT_PATTERNS.some(pattern => pattern.test(normalized))
  );
}

export function hasDurableObservationContent(fields: ObservationContentFields): boolean {
  if (isNoOpObservationContent(fields)) {
    return false;
  }

  return Boolean(
    normalizeObservationText(fields.title) ||
    normalizeObservationText(fields.subtitle) ||
    normalizeObservationText(fields.text) ||
    normalizeObservationText(fields.narrative) ||
    observationArray(fields.facts).length > 0 ||
    observationArray(fields.concepts).length > 0
  );
}

export function deriveObservationDisplayTitle(fields: ObservationContentFields, maxLength = 160): string | null {
  if (isNoOpObservationContent(fields)) {
    return null;
  }

  const title = normalizeObservationText(fields.title);
  if (title) {
    return truncateTitle(title, maxLength);
  }

  const narrative = normalizeObservationText(fields.narrative);
  if (narrative) {
    return truncateTitle(firstSentence(narrative), maxLength);
  }

  const subtitle = normalizeObservationText(fields.subtitle);
  if (subtitle) {
    return truncateTitle(subtitle, maxLength);
  }

  const text = normalizeObservationText(fields.text);
  if (text) {
    return truncateTitle(firstSentence(text), maxLength);
  }

  const firstFact = observationArray(fields.facts)[0];
  if (firstFact) {
    return truncateTitle(firstFact, maxLength);
  }

  const concepts = observationArray(fields.concepts);
  if (concepts.length > 0) {
    return truncateTitle(`Concepts: ${concepts.slice(0, 4).join(', ')}`, maxLength);
  }

  return null;
}

function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(?:\s|$)/.exec(text);
  return match?.[1] ?? text;
}

function truncateTitle(title: string, maxLength: number): string {
  if (title.length <= maxLength) {
    return title;
  }
  return `${title.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
