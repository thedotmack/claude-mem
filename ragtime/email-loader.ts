import { readFile, readdir } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

export interface Email {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  date: string;
  subject: string;
  body: string;
  document_id?: string;
  headers?: Record<string, string>;
  attachments?: Array<{
    filename: string;
    contentType?: string;
    size?: number;
  }>;
}

// Index.json manifest format (JSONL chunk-based corpus)
interface CorpusIndex {
  generated_at: string;
  total_emails: number;
  total_files: number;
  total_tokens: number;
  files: Array<{
    filename: string;
    participant_hash: string;
    participants: string[];
    email_count: number;
    token_count: number;
    date_range: {
      start: string;
      end: string;
    };
  }>;
}

// JSONL message format from rad-mem export
interface JsonlMessage {
  type: 'user' | 'assistant';
  message: {
    role: string;
    content: Array<{ type: string; text: string }> | string;
  };
  sessionId: string;
  timestamp: string;
  uuid: string;
}

// Legacy JSON array format
interface RawEmailData {
  id?: string;
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  date: string;
  subject: string;
  body: string;
  headers?: Record<string, string>;
  attachments?: Array<{
    filename: string;
    contentType?: string;
    size?: number;
  }>;
  messageId?: string;
}

function asArray(value: string | string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value : [value];
}

function normalizeEmail(raw: RawEmailData, index: number): Email {
  return {
    id: raw.id || raw.messageId || `email-${index + 1}`,
    from: raw.from,
    to: asArray(raw.to) || [],
    date: raw.date,
    subject: raw.subject,
    body: raw.body,
    ...(raw.cc && { cc: asArray(raw.cc) }),
    ...(raw.bcc && { bcc: asArray(raw.bcc) }),
    ...(raw.headers && { headers: raw.headers }),
    ...(raw.attachments && { attachments: raw.attachments }),
  };
}

/**
 * Parse email metadata from XML-like tags in JSONL content
 */
function parseEmailFromJsonlMessage(msg: JsonlMessage): Email | null {
  // Only process user messages (emails), skip assistant responses
  if (msg.type !== 'user') return null;

  const content = msg.message.content;
  let text: string;

  if (Array.isArray(content)) {
    const textBlock = content.find(b => b.type === 'text');
    if (!textBlock) return null;
    text = textBlock.text;
  } else {
    text = content;
  }

  // Parse <email_metadata> section
  const metadataMatch = text.match(/<email_metadata>([\s\S]*?)<\/email_metadata>/);
  if (!metadataMatch) return null;

  const metadata = metadataMatch[1];

  // Extract fields from XML-like tags
  const documentId = metadata.match(/<document_id>(.*?)<\/document_id>/)?.[1]?.trim();
  const sent = metadata.match(/<sent>(.*?)<\/sent>/)?.[1]?.trim();
  const subject = metadata.match(/<subject>(.*?)<\/subject>/)?.[1]?.trim() || '(no subject)';
  const from = metadata.match(/<from>(.*?)<\/from>/)?.[1]?.trim();
  const to = metadata.match(/<to>(.*?)<\/to>/)?.[1]?.trim();

  // Body is everything after </email_metadata>
  const bodyStart = text.indexOf('</email_metadata>') + '</email_metadata>'.length;
  const body = text.slice(bodyStart).trim();

  return {
    id: msg.uuid || documentId || `email-${Date.now()}`,
    document_id: documentId,
    from: from || '(unknown sender)',
    to: to ? [to] : [],
    date: sent || msg.timestamp,
    subject,
    body,
  };
}

/**
 * Load emails from a JSONL file (one JSON object per line)
 */
async function loadJsonlFile(filePath: string): Promise<Email[]> {
  const emails: Email[] = [];

  const fileStream = createReadStream(filePath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const msg: JsonlMessage = JSON.parse(line);
      const email = parseEmailFromJsonlMessage(msg);
      if (email) {
        emails.push(email);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return emails;
}

/**
 * Load emails from index.json manifest (JSONL chunk-based corpus)
 */
async function loadFromIndex(indexPath: string): Promise<Email[]> {
  const absolutePath = resolve(indexPath);
  const baseDir = dirname(absolutePath);

  const indexData = await readFile(absolutePath, 'utf-8');
  const index: CorpusIndex = JSON.parse(indexData);

  console.log(`Loading corpus: ${index.total_emails} emails across ${index.files.length} files`);

  const allEmails: Email[] = [];

  for (const fileInfo of index.files) {
    const chunkPath = join(baseDir, fileInfo.filename);
    const emails = await loadJsonlFile(chunkPath);
    allEmails.push(...emails);
  }

  return allEmails;
}

/**
 * Load emails from legacy JSON array format
 */
async function loadFromJsonArray(jsonPath: string): Promise<Email[]> {
  const absolutePath = resolve(jsonPath);
  const rawData = await readFile(absolutePath, 'utf-8');
  const parsed: RawEmailData[] = JSON.parse(rawData);
  return parsed.map((raw, index) => normalizeEmail(raw, index));
}

/**
 * Load emails from corpus path (auto-detects format)
 *
 * Supports:
 * - index.json manifest with JSONL chunks
 * - Single JSON array file
 * - Directory containing JSONL files
 */
export async function loadEmails(corpusPath: string): Promise<Email[]> {
  const absolutePath = resolve(corpusPath);

  let emails: Email[];

  if (absolutePath.endsWith('index.json')) {
    // Index-based JSONL corpus
    emails = await loadFromIndex(absolutePath);
  } else if (absolutePath.endsWith('.jsonl')) {
    // Single JSONL file
    emails = await loadJsonlFile(absolutePath);
  } else if (absolutePath.endsWith('.json')) {
    // Legacy JSON array
    emails = await loadFromJsonArray(absolutePath);
  } else {
    // Try as directory containing index.json
    const indexPath = join(absolutePath, 'index.json');
    try {
      emails = await loadFromIndex(indexPath);
    } catch {
      throw new Error(`Unknown corpus format: ${absolutePath}. Expected index.json, .jsonl, or .json file.`);
    }
  }

  // Sort by date ascending
  emails.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // Deduplicate by id
  const seenIds = new Set<string>();
  const deduplicatedEmails = emails.filter(email => {
    if (seenIds.has(email.id)) return false;
    seenIds.add(email.id);
    return true;
  });

  console.log(`Loaded ${deduplicatedEmails.length} emails from ${absolutePath}`);
  if (deduplicatedEmails.length < emails.length) {
    console.log(`  Removed ${emails.length - deduplicatedEmails.length} duplicates by id`);
  }

  return deduplicatedEmails;
}
