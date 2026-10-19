/**
 * Line edits to Hermes's config.yaml for the two keys claude-mem owns there:
 * `memory.provider` and `mcp_servers.claude-mem`.
 *
 * Hermes writes its config as block-style YAML, and users keep comments in it,
 * so the file is edited line by line instead of being parsed and re-dumped:
 * every line claude-mem does not own is left byte for byte. A shape these edits
 * cannot follow (a flow mapping such as `memory: {provider: x}`) throws
 * HermesConfigShapeError and the file is not touched.
 */

export class HermesConfigShapeError extends Error {}

const TOP_LEVEL_KEY = /^([A-Za-z_][\w-]*)(\s*):(.*)$/;

interface Block {
  /** Index of the `key:` line. */
  header: number;
  /** One past the last line that belongs to the block. */
  end: number;
  /** Indent of the block's children (2 when it has none yet). */
  childIndent: number;
}

function splitLines(text: string): { lines: string[]; eol: string; bom: string } {
  // Windows editors save UTF-8 with a byte-order mark; it is not part of the first key.
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.slice(bom.length).split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { lines, eol, bom };
}

function joinLines(lines: string[], eol: string, bom: string): string {
  return lines.length === 0 ? bom : bom + lines.join(eol) + eol;
}

function stripComment(value: string): string {
  // A `#` starts a comment only at the start or after whitespace.
  const match = /(^|\s)#/.exec(value);
  return (match ? value.slice(0, match.index) : value).trim();
}

function isContent(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== '' && !trimmed.startsWith('#');
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The block for a top-level key, or null when the key is absent. Throws on a
 *  value this editor cannot extend (anything but empty, `{}`, `null` or `~`). */
function findBlock(lines: string[], key: string): Block | null {
  // A file whose root keys are all indented is valid YAML, but the keys below would
  // not be found and a second block would be appended beside them.
  // A `---` document marker or a `%` directive in front of the keys is not a key.
  const firstContent = lines.find(line => isContent(line) && !/^(---(\s|$)|%)/.test(line));
  if (firstContent !== undefined && indentOf(firstContent) > 0) {
    throw new HermesConfigShapeError('the top level of config.yaml is indented; claude-mem edits only unindented root keys');
  }
  // A quoted key is the same key to YAML; editing beside it would add a duplicate.
  if (lines.some(line => line.startsWith(`"${key}"`) || line.startsWith(`'${key}'`))) {
    throw new HermesConfigShapeError(`"${key}" is written as a quoted key; claude-mem edits only plain keys`);
  }
  const headers = lines.flatMap((line, index) => TOP_LEVEL_KEY.exec(line)?.[1] === key ? [index] : []);
  if (headers.length > 1) throw new HermesConfigShapeError(`"${key}" is duplicated`);
  if (headers.length === 0) return null;
  const header = headers[0];
  const match = TOP_LEVEL_KEY.exec(lines[header])!;
  if (match[2]) throw new HermesConfigShapeError(`"${key}" has whitespace before its colon; use "${key}:"`);
  const inline = stripComment(match[3]);
  if (inline !== '' && inline !== '{}' && inline !== 'null' && inline !== '~') {
    throw new HermesConfigShapeError(`"${key}:" holds an inline value (${inline}); claude-mem edits only block-style YAML`);
  }
  let end = header + 1;
  while (end < lines.length && !(isContent(lines[end]) && indentOf(lines[end]) === 0)) end++;
  // Trailing blank lines and comments belong to whatever follows.
  while (end > header + 1 && !isContent(lines[end - 1])) end--;
  const firstChild = lines.slice(header + 1, end).find(isContent);
  if (firstChild?.startsWith('\t')) throw new HermesConfigShapeError(`"${key}:" is indented with tabs`);
  return { header, end, childIndent: firstChild ? indentOf(firstChild) : 2 };
}

function childLine(lines: string[], block: Block, child: string): number {
  let found = -1;
  for (let index = block.header + 1; index < block.end; index++) {
    const line = lines[index];
    if (!isContent(line) || indentOf(line) !== block.childIndent) continue;
    const rest = line.slice(block.childIndent);
    const match = /^([\w-]+|"[^"\n]+"|'[^'\n]+')(\s*):/.exec(rest);
    if (!match || match[1].replace(/^['"]|['"]$/g, '') !== child) continue;
    if (match[2]) throw new HermesConfigShapeError(`"${child}" has whitespace before its colon`);
    if (found !== -1) throw new HermesConfigShapeError(`"${child}" is duplicated`);
    found = index;
  }
  return found;
}

/** The end of a child entry: the next line at or above the child's indent. */
function childEnd(lines: string[], block: Block, start: number): number {
  let end = start + 1;
  while (end < block.end && !(isContent(lines[end]) && indentOf(lines[end]) <= block.childIndent)) end++;
  while (end > start + 1 && !isContent(lines[end - 1])) end--;
  return end;
}

function scalar(line: string): string {
  const value = stripComment(line.slice(line.indexOf(':') + 1));
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function hasChildren(lines: string[], block: Block): boolean {
  return lines.slice(block.header + 1, block.end).some(isContent);
}

/** Open a block for children, preserving comments and inserting before a document-end marker. */
function openBlock(lines: string[], key: string): Block {
  const existing = findBlock(lines, key);
  if (existing) {
    lines[existing.header] = lines[existing.header].replace(/^([^:]+:)[ \t]*(?:\{\}|null|~)/, '$1');
    return existing;
  }
  const documentEnd = lines.findIndex(line => /^\.\.\.(?:\s|$)/.test(line));
  if (documentEnd !== -1) {
    lines.splice(documentEnd, 0, key + ':');
    return { header: documentEnd, end: documentEnd + 1, childIndent: 2 };
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  lines.push(key + ':');
  return { header: lines.length - 1, end: lines.length, childIndent: 2 };
}

/** What `memory:` looked like before claude-mem selected itself, so uninstall can put it back. */
export interface ProviderReceipt {
  /** The original `memory:` header line, or null when claude-mem added the block. */
  memoryHeader: string | null;
  /** The original `provider:` line, or null when claude-mem added it. */
  providerLine: string | null;
}

function providerLineIndex(lines: string[], block: Block): number {
  const index = childLine(lines, block, 'provider');
  if (index === -1) return index;
  const value = stripComment(lines[index].slice(lines[index].indexOf(':') + 1));
  const quote = value[0];
  if (/^[|>\[{&*!]/.test(value)
      || ((quote === '"' || quote === "'") && !value.endsWith(quote))
      || lines.slice(index + 1, childEnd(lines, block, index)).some(isContent)) {
    throw new HermesConfigShapeError('"memory.provider" must be a single-line scalar');
  }
  return index;
}

export function readMemoryProvider(text: string): string | null {
  const { lines } = splitLines(text);
  const block = findBlock(lines, 'memory');
  if (!block) return null;
  const index = providerLineIndex(lines, block);
  return index === -1 ? null : scalar(lines[index]);
}

export function selectMemoryProvider(text: string, provider: string): { text: string; receipt: ProviderReceipt } {
  const { lines, eol, bom } = splitLines(text);
  const before = findBlock(lines, 'memory');
  const memoryHeader = before ? lines[before.header] : null;
  const block = openBlock(lines, 'memory');
  const index = providerLineIndex(lines, block);
  const line = ' '.repeat(block.childIndent) + 'provider: ' + provider;
  let providerLine: string | null = null;
  if (index === -1) {
    lines.splice(block.header + 1, 0, line);
  } else {
    providerLine = lines[index];
    lines[index] = line;
  }
  return { text: joinLines(lines, eol, bom), receipt: { memoryHeader, providerLine } };
}

/** Undo selectMemoryProvider, but only while `provider` is still selected:
 *  a provider the user chose since is theirs. */
export function restoreMemoryProvider(text: string, provider: string, receipt: ProviderReceipt): string {
  const { lines, eol, bom } = splitLines(text);
  const block = findBlock(lines, 'memory');
  if (!block) return text;
  const index = providerLineIndex(lines, block);
  if (index === -1 || scalar(lines[index]) !== provider) return text;
  if (receipt.providerLine !== null) {
    lines[index] = receipt.providerLine;
    return joinLines(lines, eol, bom);
  }
  lines.splice(index, 1);
  const after = findBlock(lines, 'memory')!;
  if (!hasChildren(lines, after)) {
    if (receipt.memoryHeader === null) lines.splice(after.header, after.end - after.header);
    else lines[after.header] = receipt.memoryHeader;
  }
  return joinLines(lines, eol, bom);
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The original `mcp_servers:` header, or null when claude-mem added the block. */
export interface McpReceipt {
  mcpHeader: string | null;
  /** Exact installed lines; an edited or legacy entry is no longer owned. */
  installedEntry: string;
}

export function hasMcpServer(text: string, name: string): boolean {
  const { lines } = splitLines(text);
  const block = findBlock(lines, 'mcp_servers');
  return block !== null && childLine(lines, block, name) !== -1;
}

export function matchesMcpReceipt(text: string, name: string, receipt: McpReceipt): boolean {
  if (typeof receipt.installedEntry !== 'string') return false;
  const { lines } = splitLines(text);
  const block = findBlock(lines, 'mcp_servers');
  if (!block) return false;
  const index = childLine(lines, block, name);
  return index !== -1 && lines.slice(index, childEnd(lines, block, index)).join('\n') === receipt.installedEntry;
}

function entryLines(name: string, entry: McpServerEntry, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  // JSON strings are valid YAML double-quoted scalars, whatever the path holds.
  const lines = [pad + name + ':', inner + 'command: ' + JSON.stringify(entry.command), inner + 'args:'];
  for (const arg of entry.args) lines.push(inner + '  - ' + JSON.stringify(arg));
  if (entry.env && Object.keys(entry.env).length > 0) {
    lines.push(inner + 'env:');
    for (const [key, value] of Object.entries(entry.env)) lines.push(inner + '  ' + key + ': ' + JSON.stringify(value));
  }
  lines.push(inner + 'enabled: true');
  return lines;
}

/** Add `mcp_servers.<name>`, replacing an entry of that name (callers decide
 *  whether an existing entry is theirs to replace). */
export function putMcpServer(text: string, name: string, entry: McpServerEntry): { text: string; receipt: McpReceipt } {
  const { lines, eol, bom } = splitLines(text);
  const before = findBlock(lines, 'mcp_servers');
  const mcpHeader = before ? lines[before.header] : null;
  const block = openBlock(lines, 'mcp_servers');
  const index = childLine(lines, block, name);
  const replacement = entryLines(name, entry, block.childIndent);
  if (index === -1) lines.splice(block.header + 1, 0, ...replacement);
  else lines.splice(index, childEnd(lines, block, index) - index, ...replacement);
  return { text: joinLines(lines, eol, bom), receipt: { mcpHeader, installedEntry: replacement.join('\n') } };
}

export function removeMcpServer(text: string, name: string, receipt: McpReceipt): string {
  if (!matchesMcpReceipt(text, name, receipt)) return text;
  const { lines, eol, bom } = splitLines(text);
  const block = findBlock(lines, 'mcp_servers');
  if (!block) return text;
  const index = childLine(lines, block, name);
  if (index === -1) return text;
  lines.splice(index, childEnd(lines, block, index) - index);
  const after = findBlock(lines, 'mcp_servers')!;
  if (!hasChildren(lines, after)) {
    if (receipt.mcpHeader === null) lines.splice(after.header, after.end - after.header);
    else lines[after.header] = receipt.mcpHeader;
  }
  return joinLines(lines, eol, bom);
}
