import { readFileSync, readdirSync, type Dirent } from 'fs';
import { join } from 'path';
import { fetchWithTimeout } from '../../../shared/worker-utils.js';
import { logger } from '../../../utils/logger.js';
import { extractFromMcp } from './connectors.js';
import { EatError } from './errors.js';
import type { EatExtractReject, EatSource } from './types.js';

export interface EatExtractOptions {
  fetchTimeoutMs: number;
  recursive?: boolean;
  stdinText?: string;
  mcp?: { resource?: string; headers?: Record<string, string> };
}

export interface EatExtractedItem {
  text: string;
  source: EatSource;
}

export interface EatExtraction {
  items: EatExtractedItem[];
  rejects: EatExtractReject[];
}

function rejectExtractItem(source: EatSource, reason: string): EatExtractReject {
  logger.warn('INGEST', 'EAT item rejected during extract', { locator: source.locator, reason });
  return { source, reason };
}

const BINARY_SNIFF_BYTES = 8192;

const BLOCK_TAG_NAMES = new Set([
  'p', 'div', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'tr', 'table', 'section', 'article', 'header', 'footer', 'blockquote', 'pre', 'hr',
]);

const SKIPPED_CONTAINER_TAG_NAMES = new Set(['script', 'style', 'head', 'noscript', 'svg', 'template']);

function decodeBasicEntities(text: string): string {
  return text
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function parseTagName(rawTag: string): { name: string; isClosing: boolean } {
  let cursor = 0;
  while (cursor < rawTag.length && rawTag[cursor] === ' ') cursor++;
  const isClosing = rawTag[cursor] === '/';
  if (isClosing) cursor++;
  let name = '';
  while (cursor < rawTag.length) {
    const char = rawTag[cursor];
    if (char === ' ' || char === '/' || char === '\t' || char === '\n' || char === '\r') break;
    name += char.toLowerCase();
    cursor++;
  }
  return { name, isClosing };
}

export function stripHtmlToText(html: string): string {
  let output = '';
  let position = 0;
  let pendingBreak = false;
  let pendingSpace = false;

  const appendText = (segment: string) => {
    for (const char of segment) {
      const isWhitespace = char === ' ' || char === '\t' || char === '\n' || char === '\r';
      if (isWhitespace) {
        if (output.length > 0 && !pendingBreak) pendingSpace = true;
        continue;
      }
      if (pendingBreak) {
        if (output.length > 0) output += '\n\n';
        pendingBreak = false;
        pendingSpace = false;
      } else if (pendingSpace) {
        output += ' ';
        pendingSpace = false;
      }
      output += char;
    }
  };

  while (position < html.length) {
    const tagOpen = html.indexOf('<', position);
    if (tagOpen === -1) {
      appendText(html.slice(position));
      break;
    }
    appendText(html.slice(position, tagOpen));
    const tagClose = html.indexOf('>', tagOpen);
    if (tagClose === -1) break;
    const rawTag = html.slice(tagOpen + 1, tagClose);
    const { name, isClosing } = parseTagName(rawTag);
    if (!isClosing && SKIPPED_CONTAINER_TAG_NAMES.has(name)) {
      const closingTag = `</${name}`;
      const containerEnd = html.toLowerCase().indexOf(closingTag, tagClose);
      if (containerEnd === -1) break;
      position = html.indexOf('>', containerEnd) + 1;
      if (position === 0) break;
      pendingBreak = true;
      continue;
    }
    if (BLOCK_TAG_NAMES.has(name)) pendingBreak = true;
    position = tagClose + 1;
  }

  return decodeBasicEntities(output);
}

function extractTagText(block: string, tagNames: string[]): string {
  const lowered = block.toLowerCase();
  for (const tagName of tagNames) {
    const openStart = lowered.indexOf(`<${tagName}`);
    if (openStart === -1) continue;
    const openEnd = block.indexOf('>', openStart);
    if (openEnd === -1) continue;
    const closeStart = lowered.indexOf(`</${tagName}`, openEnd);
    if (closeStart === -1) continue;
    let inner = block.slice(openEnd + 1, closeStart).trim();
    if (inner.startsWith('<![CDATA[') && inner.endsWith(']]>')) {
      inner = inner.slice('<![CDATA['.length, -']]>'.length).trim();
    }
    if (inner.length > 0) return inner;
  }
  return '';
}

function extractFeedEntryBlocks(xml: string): string[] {
  const lowered = xml.toLowerCase();
  const blocks: string[] = [];
  for (const tagName of ['item', 'entry']) {
    let searchFrom = 0;
    while (true) {
      const openStart = lowered.indexOf(`<${tagName}`, searchFrom);
      if (openStart === -1) break;
      const following = lowered[openStart + tagName.length + 1];
      if (following !== '>' && following !== ' ' && following !== '\n' && following !== '\t' && following !== '\r') {
        searchFrom = openStart + 1;
        continue;
      }
      const closeStart = lowered.indexOf(`</${tagName}`, openStart);
      if (closeStart === -1) break;
      blocks.push(xml.slice(openStart, closeStart));
      searchFrom = closeStart + 1;
    }
  }
  return blocks;
}

function extractFeed(xml: string, source: EatSource): EatExtractedItem[] {
  return extractFeedEntryBlocks(xml).map(block => {
    const title = decodeBasicEntities(extractTagText(block, ['title']));
    const link = decodeBasicEntities(extractTagText(block, ['link']));
    const body = stripHtmlToText(extractTagText(block, ['content:encoded', 'content', 'description', 'summary']));
    const text = [title, link, body].filter(part => part.length > 0).join('\n\n');
    return { text, source: { ...source, kind: 'feed' as const } };
  }).filter(item => item.text.length > 0);
}

function looksLikeFeed(contentType: string, body: string): boolean {
  const head = body.slice(0, BINARY_SNIFF_BYTES).toLowerCase();
  const hasFeedMarker = head.includes('<rss') || head.includes('<feed');
  return hasFeedMarker && (contentType.includes('xml') || head.startsWith('<?xml') || head.startsWith('<rss') || head.startsWith('<feed'));
}

function extractFile(filePath: string, source: EatSource): EatExtraction {
  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (error) {
    // Per-item boundary: an unreadable file becomes a rejected item, not a
    // crashed run. A totally-failed single-source run surfaces in the pipeline.
    const message = error instanceof Error ? error.message : String(error);
    return { items: [], rejects: [rejectExtractItem(source, `Unreadable file: ${message}`)] };
  }
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { items: [], rejects: [rejectExtractItem(source, 'Binary file (NUL byte in first 8KB)')] };
  }
  return { items: [{ text: buffer.toString('utf-8'), source }], rejects: [] };
}

function extractDirectory(directoryPath: string, source: EatSource, recursive: boolean): EatExtraction {
  const items: EatExtractedItem[] = [];
  const rejects: EatExtractReject[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    // An unlistable directory rejects as one item; nested it degrades the run,
    // top-level the pipeline turns nothing-extracted into an error.
    const message = error instanceof Error ? error.message : String(error);
    return { items: [], rejects: [rejectExtractItem({ kind: 'directory', locator: directoryPath }, `Unreadable directory: ${message}`)] };
  }
  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      if (!recursive) continue;
      const nested = extractDirectory(entryPath, source, recursive);
      items.push(...nested.items);
      rejects.push(...nested.rejects);
      continue;
    }
    if (!entry.isFile()) continue;
    const fileExtraction = extractFile(entryPath, { kind: 'file', locator: entryPath });
    items.push(...fileExtraction.items);
    rejects.push(...fileExtraction.rejects);
  }
  return { items, rejects };
}

async function fetchSourceBody(source: EatSource, opts: EatExtractOptions): Promise<{ contentType: string; body: string }> {
  let response: Awaited<ReturnType<typeof fetchWithTimeout>>;
  try {
    response = await fetchWithTimeout(source.locator, {}, opts.fetchTimeoutMs);
  } catch (error) {
    // A single URL/feed IS the whole source — an unreachable one is an
    // upstream failure, never an empty success.
    const message = error instanceof Error ? error.message : String(error);
    throw new EatError('upstream_fetch_failed', `Fetch failed for ${source.locator}: ${message}`);
  }
  if (!response.ok) {
    throw new EatError('upstream_fetch_failed', `Fetch failed for ${source.locator}: HTTP ${response.status}`);
  }
  return { contentType: response.headers.get('content-type') ?? '', body: await response.text() };
}

async function extractUrl(source: EatSource, opts: EatExtractOptions): Promise<EatExtraction> {
  const { contentType, body } = await fetchSourceBody(source, opts);
  const resolvedSource: EatSource = { ...source, contentType };
  if (looksLikeFeed(contentType, body)) {
    return { items: extractFeed(body, resolvedSource), rejects: [] };
  }
  if (contentType.includes('html')) {
    return { items: [{ text: stripHtmlToText(body), source: resolvedSource }], rejects: [] };
  }
  return { items: [{ text: body, source: resolvedSource }], rejects: [] };
}

export async function extractItems(source: EatSource, opts: EatExtractOptions): Promise<EatExtraction> {
  switch (source.kind) {
    case 'file':
      return extractFile(source.locator, source);
    case 'directory':
      return extractDirectory(source.locator, source, opts.recursive === true);
    case 'url':
      return extractUrl(source, opts);
    case 'feed': {
      const { body } = await fetchSourceBody(source, opts);
      return { items: extractFeed(body, source), rejects: [] };
    }
    case 'stdin': {
      const text = opts.stdinText ?? readFileSync(0, 'utf-8');
      return { items: [{ text, source }], rejects: [] };
    }
    case 'text':
      return { items: [{ text: source.locator, source }], rejects: [] };
    case 'mcp':
      return extractFromMcp(source.locator, { resource: opts.mcp?.resource, headers: opts.mcp?.headers });
  }
}
