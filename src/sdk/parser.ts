/**
 * XML Parser Module
 * Parses observation and summary XML blocks from SDK responses
 */

export interface ParsedObservation {
  type: string;
  text: string;
}

export interface ParsedSummary {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  files_read: string[];
  files_edited: string[];
  notes: string;
}

/**
 * Parse observation XML blocks from SDK response
 * Returns all observations found in the response
 */
export function parseObservations(text: string): ParsedObservation[] {
  const observations: ParsedObservation[] = [];

  // Match <observation>...</observation> blocks (non-greedy)
  const observationRegex = /<observation>\s*<type>([^<]+)<\/type>\s*<text>([^<]+)<\/text>\s*<\/observation>/g;

  let match;
  while ((match = observationRegex.exec(text)) !== null) {
    const type = match[1].trim();
    const observationText = match[2].trim();

    // Validate type
    const validTypes = ['decision', 'bugfix', 'feature', 'refactor', 'discovery'];
    if (!validTypes.includes(type)) {
      console.warn(`[SDK Parser] Invalid observation type: ${type}, skipping`);
      continue;
    }

    observations.push({
      type,
      text: observationText
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

  // Extract required fields
  const request = extractField(summaryContent, 'request');
  const investigated = extractField(summaryContent, 'investigated');
  const learned = extractField(summaryContent, 'learned');
  const completed = extractField(summaryContent, 'completed');
  const next_steps = extractField(summaryContent, 'next_steps');
  const notes = extractField(summaryContent, 'notes');

  // Extract file arrays
  const files_read = extractFileArray(summaryContent, 'files_read');
  const files_edited = extractFileArray(summaryContent, 'files_edited');

  // Validate all required fields are present
  if (!request || !investigated || !learned || !completed || !next_steps || !notes) {
    console.warn('[SDK Parser] Summary missing required fields');
    return null;
  }

  return {
    request,
    investigated,
    learned,
    completed,
    next_steps,
    files_read,
    files_edited,
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
