/**
 * XML Parser Module
 * Parses observation and summary XML blocks from SDK responses
 */

export interface ParsedObservation {
  type: string;
  title: string;
  subtitle: string;
  facts: string[];
  narrative: string;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface ParsedSummary {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
}

/**
 * Parse observation XML blocks from SDK response
 * Returns all observations found in the response
 */
export function parseObservations(text: string): ParsedObservation[] {
  const observations: ParsedObservation[] = [];

  // Match <observation>...</observation> blocks (non-greedy)
  const observationRegex = /<observation>([\s\S]*?)<\/observation>/g;

  let match;
  while ((match = observationRegex.exec(text)) !== null) {
    const obsContent = match[1];

    // Extract all fields
    const type = extractField(obsContent, 'type');
    const title = extractField(obsContent, 'title');
    const subtitle = extractField(obsContent, 'subtitle');
    const narrative = extractField(obsContent, 'narrative');
    const facts = extractArrayElements(obsContent, 'facts', 'fact');
    const concepts = extractArrayElements(obsContent, 'concepts', 'concept');
    const files_read = extractArrayElements(obsContent, 'files_read', 'file');
    const files_modified = extractArrayElements(obsContent, 'files_modified', 'file');

    // Validate required fields
    if (!type || !title || !subtitle || !narrative) {
      console.warn('[SDK Parser] Observation missing required fields, skipping');
      continue;
    }

    // Validate type
    const validTypes = ['change', 'discovery', 'decision'];
    if (!validTypes.includes(type.trim())) {
      console.warn(`[SDK Parser] Invalid observation type: ${type}, skipping`);
      continue;
    }

    observations.push({
      type: type.trim(),
      title,
      subtitle,
      facts,
      narrative,
      concepts,
      files_read,
      files_modified
    });
  }

  return observations;
}

/**
 * Parse summary XML block from SDK response
 * Returns null if no valid summary found
 */
export function parseSummary(text: string): ParsedSummary | null {
  // Match <summary>...</summary> block (non-greedy)
  const summaryRegex = /<summary>([\s\S]*?)<\/summary>/;
  const summaryMatch = summaryRegex.exec(text);

  if (!summaryMatch) {
    return null;
  }

  const summaryContent = summaryMatch[1];

  // Extract fields
  const request = extractField(summaryContent, 'request');
  const investigated = extractField(summaryContent, 'investigated');
  const learned = extractField(summaryContent, 'learned');
  const completed = extractField(summaryContent, 'completed');
  const next_steps = extractField(summaryContent, 'next_steps');
  const notes = extractField(summaryContent, 'notes'); // Optional

  // Validate required fields are present (notes is optional)
  if (!request || !investigated || !learned || !completed || !next_steps) {
    console.warn('[SDK Parser] Summary missing required fields');
    return null;
  }

  return {
    request,
    investigated,
    learned,
    completed,
    next_steps,
    notes
  };
}

/**
 * Extract a simple field value from XML content
 */
function extractField(content: string, fieldName: string): string | null {
  const regex = new RegExp(`<${fieldName}>([^<]*)</${fieldName}>`);
  const match = regex.exec(content);
  return match ? match[1].trim() : null;
}

/**
 * Extract file array from XML content
 * Handles both <file> children and empty tags
 */
function extractFileArray(content: string, arrayName: string): string[] {
  const files: string[] = [];

  // Match the array block
  const arrayRegex = new RegExp(`<${arrayName}>(.*?)</${arrayName}>`, 's');
  const arrayMatch = arrayRegex.exec(content);

  if (!arrayMatch) {
    return files;
  }

  const arrayContent = arrayMatch[1];

  // Extract individual <file> elements
  const fileRegex = /<file>([^<]+)<\/file>/g;
  let fileMatch;
  while ((fileMatch = fileRegex.exec(arrayContent)) !== null) {
    files.push(fileMatch[1].trim());
  }

  return files;
}

/**
 * Extract array of elements from XML content
 * Generic version of extractFileArray that works with any element name
 */
function extractArrayElements(content: string, arrayName: string, elementName: string): string[] {
  const elements: string[] = [];

  // Match the array block
  const arrayRegex = new RegExp(`<${arrayName}>(.*?)</${arrayName}>`, 's');
  const arrayMatch = arrayRegex.exec(content);

  if (!arrayMatch) {
    return elements;
  }

  const arrayContent = arrayMatch[1];

  // Extract individual elements
  const elementRegex = new RegExp(`<${elementName}>([^<]+)</${elementName}>`, 'g');
  let elementMatch;
  while ((elementMatch = elementRegex.exec(arrayContent)) !== null) {
    elements.push(elementMatch[1].trim());
  }

  return elements;
}
