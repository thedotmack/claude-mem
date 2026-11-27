import { createReadStream } from 'node:fs';
import { lstat, opendir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { openPromise, type Entry } from 'yauzl';

export interface ExportFile { name: string; value: unknown }

const CHAT_FILE = /^conversations(?:[-_]\d+)?\.json$/;
const NATIVE_FILE = /^[^/]+\.jsonl$/i;
const PROJECT_FILE = /^projects\/[\w-]+\.json$/;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_SELECTED_FILES = 16_384;

function isProjectFile(name: string): boolean {
  return name === 'projects.json' || PROJECT_FILE.test(name);
}

function exportOrder(a: string, b: string): number {
  return Number(isProjectFile(b)) - Number(isProjectFile(a)) || (a < b ? -1 : a > b ? 1 : 0);
}

function checkSize(bytes: number, remaining: number): void {
  if (bytes > MAX_FILE_BYTES || bytes > remaining) {
    throw new Error('Export is too large to read in one import. Select a smaller conversations shard or individual transcript.');
  }
}

// Count actual bytes as well as the declared size. A changed file or corrupt
// compressed entry cannot exceed the budget between the size check and JSON.parse.
async function parseFile(name: string, stream: Readable, remaining: number): Promise<{file: ExportFile; bytes: number}> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.byteLength;
    checkSize(bytes, remaining);
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks, bytes).toString('utf8').replace(/^\uFEFF/, '');
  try {
    const value = /\.jsonl$/i.test(name)
      ? raw.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
      : JSON.parse(raw);
    return { file: { name, value }, bytes };
  } catch {
    // JSON.parse messages on newer runtimes can contain fragments of private chats.
    throw new Error(`Invalid JSON in ${name}.`);
  }
}

async function listProjectFiles(directory: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of await opendir(directory)) {
    if (entry.isFile() && entry.name === 'projects.json') names.push(entry.name);
    if (entry.isDirectory() && entry.name === 'projects') {
      for await (const project of await opendir(join(directory, entry.name))) {
        const name = 'projects/' + project.name;
        if (project.isFile() && PROJECT_FILE.test(name)) names.push(name);
        if (names.length > MAX_SELECTED_FILES) throw new Error('Too many project files in this export.');
      }
    }
  }
  return names;
}

async function listChatFiles(directory: string): Promise<string[]> {
  const chats: string[] = [];
  const nativeSessions: string[] = [];
  for await (const entry of await opendir(directory)) {
    if (!entry.isFile()) continue;
    if (CHAT_FILE.test(entry.name)) chats.push(entry.name);
    else if (NATIVE_FILE.test(entry.name)) nativeSessions.push(entry.name);
    if (chats.length + nativeSessions.length > MAX_SELECTED_FILES) throw new Error('Too many transcript files in this export.');
  }
  return chats.length ? chats : nativeSessions;
}

/** Recognize root-level provider archives and the same archive inside a single enclosing folder. */
async function* readZip(path: string): AsyncGenerator<ExportFile> {
  const zip = await openPromise(path, { autoClose: false, strictFileNames: true, validateEntrySizes: true });
  try {
    const selected = new Map<string, Entry>();
    let commonFolder: string | null | undefined;
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
      const slash = name.indexOf('/');
      const folder = slash < 0 ? null : name.slice(0, slash);
      commonFolder = commonFolder === undefined || commonFolder === folder ? folder : null;
      const inner = slash < 0 ? name : name.slice(slash + 1);
      if (![name, inner].some(file => CHAT_FILE.test(file) || isProjectFile(file) || NATIVE_FILE.test(file))) continue;
      if (selected.has(name)) throw new Error('Export contains duplicate JSON entries.');
      selected.set(name, entry);
      if (selected.size > MAX_SELECTED_FILES) throw new Error('Too many JSON files in this export.');
    }
    // A project log directory may be zipped as a single wrapper. A ZIP holding
    // only attachments or subagent logs never makes those directories the session root.
    const wrapper = commonFolder && !['attachments', 'files', 'projects', 'subagents'].includes(commonFolder.toLowerCase());
    const prefix = wrapper ? commonFolder + '/' : '';
    const entries = [...selected.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, entry]) => ({ name: path.slice(prefix.length), entry }))
      .sort((a, b) => exportOrder(a.name, b.name));
    const providerExport = entries.some(({name}) => CHAT_FILE.test(name));
    const inputs = entries.filter(({name}) => providerExport ? CHAT_FILE.test(name) || isProjectFile(name) : NATIVE_FILE.test(name));
    if (!inputs.length) throw new Error('No conversations JSON or root-level JSONL transcripts found in this export ZIP.');
    let remaining = MAX_TOTAL_BYTES;
    for (const {name, entry} of inputs) {
      checkSize(entry.uncompressedSize, remaining);
      const parsed = await parseFile(name, await zip.openReadStreamPromise(entry), remaining);
      remaining -= parsed.bytes;
      yield parsed.file;
    }
  } finally {
    zip.close();
  }
}

/** Read only the selected export and its explicit project catalog. ZIP entries never touch disk. */
export async function* readExportFiles(path: string): AsyncGenerator<ExportFile> {
  const info = await stat(path);
  if (info.isFile() && extname(path).toLowerCase() === '.zip') {
    yield* readZip(path);
    return;
  }
  const directory = info.isDirectory() ? path : dirname(path);
  let names: string[];
  if (info.isDirectory()) {
    const chats = await listChatFiles(directory);
    if (!chats.length) throw new Error('No conversations JSON or JSONL transcripts found in this directory.');
    names = chats.some(name => CHAT_FILE.test(name)) ? [...await listProjectFiles(directory), ...chats] : chats;
  } else if (info.isFile() && /\.jsonl?$/i.test(path)) {
    const name = basename(path);
    names = CHAT_FILE.test(name) ? [...await listProjectFiles(directory), name] : [name];
  } else {
    throw new Error('Select an export ZIP, JSON, JSONL transcript, or extracted export directory.');
  }
  let remaining = MAX_TOTAL_BYTES;
  for (const name of names.sort(exportOrder)) {
    const file = join(directory, name);
    const info = await lstat(file);
    if (!info.isFile()) throw new Error(`Expected a regular file for ${name}.`);
    checkSize(info.size, remaining);
    const parsed = await parseFile(name, createReadStream(file), remaining);
    remaining -= parsed.bytes;
    yield parsed.file;
  }
}
