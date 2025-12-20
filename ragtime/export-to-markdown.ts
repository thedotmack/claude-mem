#!/usr/bin/env bun
/**
 * Export emails to individual markdown files
 *
 * Creates one .md file per email with simple sequential naming (0001.md, 0002.md, etc)
 */

import { loadEmails, type Email } from './email-loader.js';
import { writeFile, mkdir } from 'fs/promises';
import { resolve, join } from 'path';

const CORPUS_PATH = process.env.CORPUS_PATH || './datasets/epstein-emails/index.json';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './datasets/emails-markdown';
const EMAIL_LIMIT = process.env.EMAIL_LIMIT ? parseInt(process.env.EMAIL_LIMIT, 10) : undefined;

function emailToMarkdown(email: Email): string {
  const lines = [
    `# ${email.subject}`,
    '',
    '## Metadata',
    '',
    `- **From:** ${email.from}`,
    `- **To:** ${email.to.join(', ')}`,
  ];

  if (email.cc && email.cc.length > 0) {
    lines.push(`- **CC:** ${email.cc.join(', ')}`);
  }

  if (email.bcc && email.bcc.length > 0) {
    lines.push(`- **BCC:** ${email.bcc.join(', ')}`);
  }

  lines.push(
    `- **Date:** ${email.date}`,
    `- **ID:** ${email.id}`,
  );

  if (email.document_id) {
    lines.push(`- **Document ID:** ${email.document_id}`);
  }

  if (email.attachments && email.attachments.length > 0) {
    lines.push('', '## Attachments', '');
    for (const attachment of email.attachments) {
      lines.push(`- ${attachment.filename}${attachment.contentType ? ` (${attachment.contentType})` : ''}`);
    }
  }

  lines.push(
    '',
    '## Body',
    '',
    email.body
  );

  return lines.join('\n');
}

async function main(): Promise<void> {
  console.log('Email to Markdown Exporter');
  console.log('==========================\n');

  const corpusAbsPath = resolve(CORPUS_PATH);
  console.log(`Corpus: ${corpusAbsPath}`);

  let emails = await loadEmails(corpusAbsPath);

  if (EMAIL_LIMIT && EMAIL_LIMIT < emails.length) {
    emails = emails.slice(0, EMAIL_LIMIT);
    console.log(`Limited to ${emails.length} emails\n`);
  } else {
    console.log(`Loaded ${emails.length} emails\n`);
  }

  const outputDir = resolve(OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true });
  console.log(`Output: ${outputDir}\n`);

  const totalDigits = emails.length.toString().length;

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    const fileNumber = (i + 1).toString().padStart(totalDigits, '0');
    const filename = `${fileNumber}.md`;
    const filepath = join(outputDir, filename);

    const markdown = emailToMarkdown(email);
    await writeFile(filepath, markdown, 'utf-8');

    if ((i + 1) % 100 === 0) {
      console.log(`Exported ${i + 1}/${emails.length} emails...`);
    }
  }

  console.log(`\n✓ Exported ${emails.length} emails to ${outputDir}`);
}

main().catch(error => {
  console.error('\nError:', error);
  process.exit(1);
});
