// SPDX-License-Identifier: Apache-2.0
//
// A comment-preserving YAML editor for block mappings (plan Phase 7 task 5).
// magpie edits YAML through yaml.v3's node tree (internal/edit/yaml.go:117-150,
// 379-396, MIT, Copyright (c) 2026 yetone); Bun has no YAML CST and
// Bun.YAML.stringify drops comments, so this editor splices lines instead:
// it finds a key by indentation, replaces or removes that entry's lines, or
// inserts new ones at the mapping's indent. The output is validated with
// Bun.YAML.parse and compared at the edited path.
//
// Anchors, aliases, multiple documents, directives and flow-mapping parents
// are refused with an explicit "edit by hand" error: a line splice cannot
// keep their meaning. This replaces the regex YAML edit for Goose
// (McpIntegrations.ts:140-233) in Phase 14.

import {
  assertPlainConfigValue,
  decodeConfigText,
  editConfigTextPreservingShape,
  isPlainObjectValue,
  keysOverlap,
  splitLiteralConfigKeyPath,
  valueAtKeys,
} from './text-shape.js';

interface YamlLine {
  start: number;
  /** End of the line's text, before `\r\n` / `\n`. */
  end: number;
  /** Start of the next line (the end of the text for the last line). */
  next: number;
  text: string;
  indent: number;
  kind: 'blank' | 'comment' | 'content';
  /** A line inside a `|` / `>` block scalar: text, whatever it looks like. */
  insideBlockScalar: boolean;
}

interface YamlEntry {
  key: string;
  lineIndex: number;
  indent: number;
  /** Offset just past the key's `:`. */
  colonEnd: number;
  /** The inline value on the key line, without its comment. */
  inlineValueStart: number;
  inlineValueEnd: number;
  inlineValue: string;
  /** One past the last line that belongs to the entry (its key line or a child line). */
  blockEndLineIndex: number;
}

interface YamlMappingRange {
  fromLineIndex: number;
  toLineIndex: number;
  indent: number;
}

function refuseYaml(reason: string): never {
  throw new Error(`${reason}; edit the file by hand`);
}

function isBlockScalarIndicator(token: string): boolean {
  if (token.length === 0 || token.length > 3 || (token[0] !== '|' && token[0] !== '>')) return false;
  for (const character of token.slice(1)) {
    if (character !== '-' && character !== '+' && !(character >= '1' && character <= '9')) return false;
  }
  return true;
}

/** The offset (within `text`) where a comment starts, or text.length. Quotes open only at a token start. */
function commentStartIn(text: string, from: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = from; index < text.length; index++) {
    const character = text[index];
    const previous = index === from ? ' ' : text[index - 1];
    if (quote === '"') {
      if (character === '\\') index++;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'" && text[index + 1] === "'") index++;
      else if (character === "'") quote = null;
      continue;
    }
    const atTokenStart = previous === ' ' || previous === '\t' || previous === '[' || previous === '{' || previous === ',' || previous === ':';
    if ((character === '"' || character === "'") && atTokenStart) {
      quote = character;
      continue;
    }
    if (character === '#' && (previous === ' ' || previous === '\t' || index === from)) return index;
  }
  return text.length;
}

function splitYamlLines(text: string): YamlLine[] {
  const lines: YamlLine[] = [];
  let start = 0;
  while (start < text.length) {
    const lineFeed = text.indexOf('\n', start);
    const next = lineFeed === -1 ? text.length : lineFeed + 1;
    let end = lineFeed === -1 ? text.length : lineFeed;
    if (end > start && text[end - 1] === '\r') end--;
    const lineText = text.slice(start, end);
    let indent = 0;
    while (lineText[indent] === ' ') indent++;
    const rest = lineText.slice(indent).trimEnd();
    const kind = rest === '' ? 'blank' : rest.startsWith('#') ? 'comment' : 'content';
    if (kind === 'content' && lineText[indent] === '\t') refuseYaml(`a tab indents line ${lines.length + 1}`);
    lines.push({ start, end, next, text: lineText, indent, kind, insideBlockScalar: false });
    start = next;
  }
  return lines;
}

/** True when a content line's value (after `key:` or `- `) opens a block scalar. */
function opensBlockScalar(line: YamlLine): boolean {
  const withoutComment = line.text.slice(0, commentStartIn(line.text, line.indent)).trimEnd();
  const lastSpace = Math.max(withoutComment.lastIndexOf(' '), withoutComment.lastIndexOf('\t'));
  const token = withoutComment.slice(lastSpace + 1);
  if (!isBlockScalarIndicator(token)) return false;
  const before = withoutComment.slice(0, lastSpace + 1).trimEnd();
  return before.endsWith(':') || before.endsWith('-') || before === '';
}

/**
 * Mark block scalar text, and refuse what a line splice cannot keep the
 * meaning of: several documents, directives, anchors and aliases.
 */
function classifyAndGuardYamlLines(lines: YamlLine[]): void {
  let blockScalarParentIndent = -1;
  let sawContent = false;
  for (const [index, line] of lines.entries()) {
    if (blockScalarParentIndent !== -1 && (line.kind === 'blank' || line.indent > blockScalarParentIndent)) {
      line.insideBlockScalar = true;
      continue;
    }
    blockScalarParentIndent = -1;
    if (line.kind !== 'content') continue;
    const trimmed = line.text.trimEnd();
    if (line.indent === 0 && (trimmed === '---' || trimmed.startsWith('--- ') || trimmed.startsWith('---\t'))) {
      if (sawContent) refuseYaml(`line ${index + 1} starts a second YAML document`);
      if (trimmed !== '---' && !trimmed.slice(3).trimStart().startsWith('#')) refuseYaml(`line ${index + 1} puts a value on the document marker`);
      // One leading `---` opens the only document: structurally a no-op line.
      line.kind = 'comment';
      continue;
    }
    if (line.indent === 0 && (trimmed === '...' || trimmed.startsWith('... '))) refuseYaml(`line ${index + 1} ends a YAML document`);
    if (line.indent === 0 && trimmed.startsWith('%')) refuseYaml(`line ${index + 1} is a YAML directive`);
    sawContent = true;
    const commentStart = commentStartIn(line.text, line.indent);
    let quote: '"' | "'" | null = null;
    for (let position = line.indent; position < commentStart; position++) {
      const character = line.text[position];
      if (quote === '"') {
        if (character === '\\') position++;
        else if (character === '"') quote = null;
        continue;
      }
      if (quote === "'") {
        if (character === "'") quote = null;
        continue;
      }
      const previous = position === line.indent ? ' ' : line.text[position - 1];
      const atTokenStart = previous === ' ' || previous === '\t' || previous === '[' || previous === '{' || previous === ',';
      if ((character === '"' || character === "'") && atTokenStart) {
        quote = character;
        continue;
      }
      const nextCharacter = line.text[position + 1];
      if ((character === '&' || character === '*') && atTokenStart && nextCharacter !== undefined && nextCharacter !== ' ' && nextCharacter !== '\t') {
        refuseYaml(`line ${index + 1} uses a YAML ${character === '&' ? 'anchor' : 'alias'}`);
      }
      if (character === '<' && line.text.startsWith('<<:', position) && position === line.indent) refuseYaml(`line ${index + 1} uses a YAML merge key`);
    }
    if (opensBlockScalar(line)) blockScalarParentIndent = line.indent;
  }
}

/** Parse the key at the start of a content line: `key:`, `"key":` or `'key':`. */
function parseYamlKeyLine(line: YamlLine, lineIndex: number): Omit<YamlEntry, 'blockEndLineIndex'> {
  const text = line.text;
  let position = line.indent;
  let key: string;
  const first = text[position];
  if (first === '"') {
    let end = position + 1;
    while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
    if (end >= text.length) refuseYaml(`line ${lineIndex + 1} has a key YAML spreads over lines`);
    try {
      key = JSON.parse(text.slice(position, end + 1)) as string;
    } catch {
      refuseYaml(`line ${lineIndex + 1} has a quoted key with escapes this editor does not read`);
    }
    position = end + 1;
  } else if (first === "'") {
    let end = position + 1;
    key = '';
    for (;;) {
      if (end >= text.length) refuseYaml(`line ${lineIndex + 1} has a key YAML spreads over lines`);
      if (text[end] === "'" && text[end + 1] === "'") {
        key += "'";
        end += 2;
      } else if (text[end] === "'") {
        break;
      } else {
        key += text[end++];
      }
    }
    position = end + 1;
  } else {
    if ('-?[]{}&*!|>%@`#,'.includes(first)) refuseYaml(`line ${lineIndex + 1} is not a "key: value" line`);
    let end = position;
    while (end < text.length && !(text[end] === ':' && (end + 1 === text.length || text[end + 1] === ' ' || text[end + 1] === '\t' || text[end + 1] === '\r'))) end++;
    if (end >= text.length) refuseYaml(`line ${lineIndex + 1} is not a "key: value" line`);
    key = text.slice(position, end).trimEnd();
    position = end;
  }
  while (text[position] === ' ' || text[position] === '\t') position++;
  if (text[position] !== ':') refuseYaml(`line ${lineIndex + 1} is not a "key: value" line`);
  const colonEndInLine = position + 1;
  let valueStart = colonEndInLine;
  while (text[valueStart] === ' ' || text[valueStart] === '\t') valueStart++;
  const valueEnd = Math.max(valueStart, text.slice(0, commentStartIn(text, valueStart)).trimEnd().length);
  return {
    key,
    lineIndex,
    indent: line.indent,
    colonEnd: line.start + colonEndInLine,
    inlineValueStart: line.start + valueStart,
    inlineValueEnd: line.start + valueEnd,
    inlineValue: text.slice(valueStart, valueEnd),
  };
}

function isSequenceItemLine(line: YamlLine): boolean {
  return line.text[line.indent] === '-' && (line.text.length === line.indent + 1 || line.text[line.indent + 1] === ' ' || line.text[line.indent + 1] === '\t');
}

/** The entries of the block mapping at `range.indent`; a key written twice is refused. */
function mappingEntries(lines: YamlLine[], range: YamlMappingRange): YamlEntry[] {
  const entries: YamlEntry[] = [];
  const seenKeys = new Set<string>();
  for (let index = range.fromLineIndex; index < range.toLineIndex; index++) {
    const line = lines[index];
    const current = entries[entries.length - 1];
    if (line.insideBlockScalar) {
      // Blank lines at the end of a block scalar are its own (a `|+` scalar keeps them as line breaks),
      // so a new entry goes after them, and deleting the entry takes them along.
      if (current) current.blockEndLineIndex = index + 1;
      continue;
    }
    if (line.kind !== 'content') continue;
    if (line.indent < range.indent) break;
    const indentlessSequenceItem = line.indent === range.indent && isSequenceItemLine(line) && current?.inlineValue === '';
    if (line.indent > range.indent || indentlessSequenceItem) {
      if (!current) refuseYaml(`line ${index + 1} is indented under nothing`);
      current.blockEndLineIndex = index + 1;
      continue;
    }
    if (isSequenceItemLine(line)) refuseYaml(`line ${index + 1} is a list item where a key was expected`);
    const entry = { ...parseYamlKeyLine(line, index), blockEndLineIndex: index + 1 };
    if (seenKeys.has(entry.key)) refuseYaml(`"${entry.key}" is written twice in one mapping`);
    seenKeys.add(entry.key);
    entries.push(entry);
  }
  return entries;
}

function firstContentLineIndex(lines: YamlLine[], from: number, to: number): number {
  for (let index = from; index < to; index++) {
    if (lines[index].kind === 'content' && !lines[index].insideBlockScalar) return index;
  }
  return -1;
}

/** The indentation step of the file: the first child line's extra indent, else two spaces. */
function indentUnitOf(lines: YamlLine[]): number {
  let previousContentLine: YamlLine | null = null;
  for (const line of lines) {
    if (line.kind !== 'content' || line.insideBlockScalar) continue;
    if (previousContentLine && line.indent > previousContentLine.indent && !isSequenceItemLine(line)) return line.indent - previousContentLine.indent;
    previousContentLine = line;
  }
  return 2;
}

/** Words YAML 1.1 readers (PyYAML, yaml.v2) take as booleans or null although YAML 1.2 reads them as strings. */
const YAML_1_1_KEYWORD_PATTERN = /^(?:y|n|yes|no|on|off|true|false|null)$/i;

/**
 * A string that reads back as itself, plain, in YAML 1.1 and 1.2 alike: it
 * starts with a letter, `_` or `/` (1.1 reads `1:20`, `0o17` and `1_000` as
 * numbers) and is not a 1.1 boolean word such as `yes` or `off`.
 */
function canBePlainYamlScalar(text: string): boolean {
  if (text.length === 0 || text.length > 256) return false;
  if (!/^[A-Za-z_/]/.test(text) || YAML_1_1_KEYWORD_PATTERN.test(text)) return false;
  for (const [index, character] of [...text].entries()) {
    const code = character.charCodeAt(0);
    const alphanumeric = (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    const allowed = alphanumeric || '_./'.includes(character) || (index > 0 && ':@+-'.includes(character));
    if (!allowed) return false;
  }
  if (text.endsWith(':')) return false;
  try {
    const parsed = Bun.YAML.parse(`probe: ${text}\n`) as Record<string, unknown> | null;
    return parsed !== null && parsed.probe === text;
  } catch {
    return false;
  }
}

function renderYamlKey(key: string): string {
  return canBePlainYamlScalar(key) ? key : JSON.stringify(key);
}

/** A scalar or flow value on one line. JSON is valid YAML flow, so arrays and objects use it. */
function renderYamlInlineValue(value: unknown): string {
  if (typeof value === 'string') return canBePlainYamlScalar(value) ? value : JSON.stringify(value);
  if (value === null) return 'null';
  return JSON.stringify(value);
}

/** `key: value` lines at `indent`; a non-empty object becomes a nested block mapping. */
function renderYamlEntryLines(key: string, value: unknown, indent: number, unit: number): string[] {
  const prefix = ' '.repeat(indent);
  if (isPlainObjectValue(value) && Object.keys(value).length > 0) {
    return [`${prefix}${renderYamlKey(key)}:`, ...Object.entries(value).flatMap(([childKey, childValue]) => renderYamlEntryLines(childKey, childValue, indent + unit, unit))];
  }
  return [`${prefix}${renderYamlKey(key)}: ${renderYamlInlineValue(value)}`];
}

function nestUnderKeys(keys: string[], value: unknown): unknown {
  let nested = value;
  for (let index = keys.length - 1; index >= 0; index--) nested = { [keys[index]]: nested };
  return nested;
}

function spliceYamlText(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

/**
 * The offset where an entry's lines stop, without the final line end. Blank
 * lines that end the entry (those that end a block scalar) are left out: a
 * value replacing the entry's lines leaves them in place as separators.
 */
function endOfBlockText(lines: YamlLine[], entry: YamlEntry): number {
  let lastLineIndex = entry.blockEndLineIndex - 1;
  while (lastLineIndex > entry.lineIndex && lines[lastLineIndex].kind === 'blank') lastLineIndex--;
  return lines[lastLineIndex].end;
}

interface ScannedYamlDocument {
  lines: YamlLine[];
  rootRange: YamlMappingRange;
  indentUnit: number;
}

/**
 * The editor's own line checks run before Bun.YAML.parse, so what they refuse
 * (a tab indent, anchors, several documents…) is refused with the same
 * message on every Bun version: Bun 1.3.9 reads a tab-indented line, 1.4.3
 * refuses it with its own message.
 */
function scanYamlDocument(text: string): ScannedYamlDocument {
  const lines = splitYamlLines(text);
  classifyAndGuardYamlLines(lines);
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (error) {
    throw new Error(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed !== null && !isPlainObjectValue(parsed)) refuseYaml('the top level is not a mapping');
  const firstContent = firstContentLineIndex(lines, 0, lines.length);
  const rootRange = { fromLineIndex: 0, toLineIndex: lines.length, indent: firstContent === -1 ? 0 : lines[firstContent].indent };
  mappingEntries(lines, rootRange); // Refuse a malformed root before any edit.
  return { lines, rootRange, indentUnit: indentUnitOf(lines) };
}

/** Insert whole lines after the line before `lineIndex` (or at the end of the text). */
function insertYamlLines(text: string, lines: YamlLine[], lineIndex: number, newLines: string[]): string {
  const block = newLines.join('\n');
  if (lineIndex >= lines.length) {
    if (text.length > 0 && !text.endsWith('\n')) return `${text}\n${block}`;
    return `${text}${block}\n`;
  }
  return spliceYamlText(text, lines[lineIndex].start, lines[lineIndex].start, `${block}\n`);
}

/** Replace an entry's value (inline text and child block) with `value`. */
function replaceYamlEntryValue(text: string, document: ScannedYamlDocument, entry: YamlEntry, value: unknown): string {
  const { lines, indentUnit } = document;
  const hasChildLines = entry.blockEndLineIndex > entry.lineIndex + 1;
  if (isPlainObjectValue(value) && Object.keys(value).length > 0) {
    const childLines = Object.entries(value).flatMap(([childKey, childValue]) => renderYamlEntryLines(childKey, childValue, entry.indent + indentUnit, indentUnit));
    return spliceYamlText(text, entry.colonEnd, endOfBlockText(lines, entry), `\n${childLines.join('\n')}`);
  }
  const rendered = renderYamlInlineValue(value);
  if (!hasChildLines && entry.inlineValue !== '') {
    // Only the value text changes; the spacing and a trailing comment stay.
    return spliceYamlText(text, entry.inlineValueStart, entry.inlineValueEnd, rendered);
  }
  const replaceEnd = hasChildLines ? endOfBlockText(lines, entry) : entry.inlineValueEnd;
  return spliceYamlText(text, entry.colonEnd, Math.max(replaceEnd, entry.colonEnd), ` ${rendered}`);
}

const EMPTY_FLOW_MAPPING_PATTERN = /^\{[ \t]*\}$/;

/** The block mapping under an entry, or a refusal when the path cannot go through it. */
function childMappingOf(document: ScannedYamlDocument, entry: YamlEntry, keyPath: string): YamlMappingRange | null {
  const { lines } = document;
  // An empty flow mapping (what deleting a mapping's last key leaves) holds nothing to keep.
  if (EMPTY_FLOW_MAPPING_PATTERN.test(entry.inlineValue)) return null;
  if (entry.inlineValue.startsWith('{')) refuseYaml(`${keyPath}: "${entry.key}" is a flow mapping`);
  if (entry.inlineValue.startsWith('[')) refuseYaml(`${keyPath}: "${entry.key}" is a list`);
  if (isBlockScalarIndicator(entry.inlineValue.split(/[ \t]/, 1)[0])) return null;
  if (entry.inlineValue !== '') return null;
  const firstChild = firstContentLineIndex(lines, entry.lineIndex + 1, entry.blockEndLineIndex);
  if (firstChild === -1) return null;
  if (isSequenceItemLine(lines[firstChild])) refuseYaml(`${keyPath}: "${entry.key}" is a list`);
  return { fromLineIndex: entry.lineIndex + 1, toLineIndex: entry.blockEndLineIndex, indent: lines[firstChild].indent };
}

function setYamlValue(text: string, keys: string[], value: unknown, keyPath: string): string {
  const document = scanYamlDocument(text);
  const { lines, indentUnit } = document;
  let range = document.rootRange;
  for (let depth = 0; depth < keys.length; depth++) {
    const entries = mappingEntries(lines, range);
    const entry = entries.find((candidate) => candidate.key === keys[depth]);
    if (!entry) {
      const insertAt = entries.length > 0 ? entries[entries.length - 1].blockEndLineIndex : range.toLineIndex;
      return insertYamlLines(text, lines, insertAt, renderYamlEntryLines(keys[depth], nestUnderKeys(keys.slice(depth + 1), value), range.indent, indentUnit));
    }
    if (depth === keys.length - 1) return replaceYamlEntryValue(text, document, entry, value);
    const child = childMappingOf(document, entry, keyPath);
    if (!child) {
      // A scalar, a null or a block scalar in the way of a deeper key becomes the mapping we need.
      return replaceYamlEntryValue(text, document, entry, nestUnderKeys(keys.slice(depth + 1), value));
    }
    range = child;
  }
  throw new Error('unreachable: a key path has at least one key');
}

function deleteYamlValue(text: string, keys: string[], keyPath: string): string {
  const document = scanYamlDocument(text);
  const { lines } = document;
  let range: YamlMappingRange | null = document.rootRange;
  let parentEntry: YamlEntry | null = null;
  for (let depth = 0; depth < keys.length && range; depth++) {
    const entries = mappingEntries(lines, range);
    const entry = entries.find((candidate) => candidate.key === keys[depth]);
    if (!entry) return text;
    if (depth === keys.length - 1) {
      if (parentEntry && entries.length === 1) {
        // The mapping's last key: it stays a mapping, `{}`, as JSONC and TOML
        // keep theirs (a bare `key:` would read as null).
        return spliceYamlText(text, parentEntry.colonEnd, endOfBlockText(lines, parentEntry), ' {}');
      }
      let start = lines[entry.lineIndex].start;
      const end = lines[entry.blockEndLineIndex - 1].next;
      // A last line with no line end takes the line end before it instead.
      if (end === text.length && !text.endsWith('\n') && start > 0) start--;
      return spliceYamlText(text, start, end, '');
    }
    range = childMappingOf(document, entry, keyPath);
    parentEntry = entry;
  }
  return text;
}

export interface YamlSetOperation {
  keyPath: string;
  value: unknown;
}

export interface YamlPatch {
  set?: YamlSetOperation[];
  delete?: string[];
}

/**
 * Apply sets, then deletes, to a YAML document whose top level is a block
 * mapping and return its new bytes. A set replaces an entry's value in place
 * (a trailing comment stays), or inserts `key: value` (or a nested block
 * mapping) after the mapping's last entry at its indent. A delete removes the
 * entry's lines; deleting a nested mapping's last key leaves it `{}`. Comments, layout, a byte order mark and all-CRLF line
 * endings are kept. Invalid input, anchors, aliases, several documents and
 * flow-mapping parents are refused; the exact output is parsed with
 * Bun.YAML.parse and compared at every edited path before it is returned.
 */
export function patchYamlDocument(originalBytes: Uint8Array, patch: YamlPatch): Uint8Array {
  return editConfigTextPreservingShape(originalBytes, (text) => {
    scanYamlDocument(text); // Refuse invalid input before anything else.
    const expectations: Array<{ keys: string[]; present: boolean; value?: unknown }> = [];
    let edited = text;
    for (const operation of patch.set ?? []) {
      assertPlainConfigValue(operation.value, operation.keyPath);
      const keys = splitLiteralConfigKeyPath(operation.keyPath);
      edited = setYamlValue(edited, keys, operation.value, operation.keyPath);
      expectations.push({ keys, present: true, value: operation.value });
    }
    for (const keyPath of patch.delete ?? []) {
      const keys = splitLiteralConfigKeyPath(keyPath);
      edited = deleteYamlValue(edited, keys, keyPath);
      expectations.push({ keys, present: false });
    }
    let parsed: unknown;
    try {
      scanYamlDocument(edited);
      parsed = Bun.YAML.parse(edited);
    } catch (error) {
      throw new Error(`edited YAML is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    expectations.forEach((expectation, index) => {
      if (expectations.slice(index + 1).some((later) => keysOverlap(later.keys, expectation.keys))) return;
      const actual = valueAtKeys(parsed, expectation.keys);
      const holds = expectation.present ? Bun.deepEquals(actual, expectation.value, true) : actual === undefined;
      if (!holds) throw new Error(`edited YAML does not hold the edit at ${expectation.keys.join('.')}`);
    });
    return edited;
  });
}

/** The value at a key path (decoded by Bun.YAML.parse), or undefined. Refuses what the editor refuses. */
export function readYamlValueAtKeyPath(configBytes: Uint8Array, keyPath: string): unknown {
  const text = decodeConfigText(configBytes);
  scanYamlDocument(text);
  return valueAtKeys(Bun.YAML.parse(text), splitLiteralConfigKeyPath(keyPath));
}
