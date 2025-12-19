import { readFile } from 'fs/promises';
import { resolve } from 'path';

export interface Email {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
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

function normalizeEmail(raw: RawEmailData, index: number): Email {
  const email: Email = {
    id: raw.id || raw.messageId || `email-${index + 1}`,
    from: raw.from,
    to: Array.isArray(raw.to) ? raw.to : [raw.to],
    date: raw.date,
    subject: raw.subject,
    body: raw.body,
  };

  if (raw.cc) {
    email.cc = Array.isArray(raw.cc) ? raw.cc : [raw.cc];
  }

  if (raw.bcc) {
    email.bcc = Array.isArray(raw.bcc) ? raw.bcc : [raw.bcc];
  }

  if (raw.headers) {
    email.headers = raw.headers;
  }

  if (raw.attachments) {
    email.attachments = raw.attachments;
  }

  if (raw.messageId) {
    email.messageId = raw.messageId;
  }

  return email;
}

function validateEmail(email: Email, index: number): void {
  const requiredFields = ['from', 'to', 'date', 'subject', 'body'];
  const missing = requiredFields.filter(field => {
    const value = email[field as keyof Email];
    if (Array.isArray(value)) {
      return value.length === 0;
    }
    return !value;
  });

  if (missing.length > 0) {
    throw new Error(
      `Email at index ${index} is missing required fields: ${missing.join(', ')}`
    );
  }

  try {
    new Date(email.date);
  } catch (error) {
    throw new Error(
      `Email at index ${index} has invalid date format: ${email.date}`
    );
  }
}

export async function loadEmails(corpusPath: string): Promise<Email[]> {
  const absolutePath = resolve(corpusPath);

  let rawData: string;
  try {
    rawData = await readFile(absolutePath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to read corpus file at ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let parsed: RawEmailData[];
  try {
    parsed = JSON.parse(rawData);
  } catch (error) {
    throw new Error(
      `Failed to parse JSON from ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected JSON file to contain an array of emails, got ${typeof parsed}`
    );
  }

  const emails = parsed.map((raw, index) => normalizeEmail(raw, index));

  emails.forEach((email, index) => validateEmail(email, index));

  const sortedEmails = emails.sort((a, b) => {
    const dateA = new Date(a.date).getTime();
    const dateB = new Date(b.date).getTime();
    return dateA - dateB;
  });

  const seenMessageIds = new Set<string>();
  const deduplicatedEmails = sortedEmails.filter(email => {
    if (email.messageId) {
      if (seenMessageIds.has(email.messageId)) {
        return false;
      }
      seenMessageIds.add(email.messageId);
    }
    return true;
  });

  console.log(`Loaded ${deduplicatedEmails.length} emails from ${absolutePath}`);
  if (deduplicatedEmails.length < sortedEmails.length) {
    console.log(`  Removed ${sortedEmails.length - deduplicatedEmails.length} duplicates by message-id`);
  }

  return deduplicatedEmails;
}
