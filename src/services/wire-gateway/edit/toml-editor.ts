// SPDX-License-Identifier: Apache-2.0
//
// A comment-preserving TOML editor (plan Phase 7 task 4). It generalizes the
// line-based helpers in CodexCliInstaller.ts (`stripTomlComment`,
// `tomlStructuralLines`, `setTomlBooleanInTable`) into one linear statement
// scanner over the whole text, so strings, numbers, arrays, inline tables,
// tables and array tables are located by offset and edited by splicing text.
// The exact output is validated with Bun.TOML.parse and the value at the
// edited path is compared (magpie internal/edit/toml.go:646-677 `writeTOML`,
// MIT, Copyright (c) 2026 yetone).
//
// Bun 1.3.9's TOML parser (probed for this phase) refuses a repeated key but
// accepts a table header written twice, a header that reopens a table made by
// dotted keys, and a header that extends an inline table. All of those are
// invalid TOML that agents' own parsers refuse, so they are checked here
// explicitly. It also refuses valid TOML datetimes and `\u0001`-style escapes
// of most control characters, swaps the `\t` and `\f` escapes, drops `\u007F`
// and does not trim the line break that opens a multi-line string, so files
// holding those cannot be edited (or read) exactly here.

import {
  assertPlainConfigValue,
  decodeConfigText,
  editConfigTextPreservingShape,
  isPlainObjectValue,
  keysOverlap,
  splitLiteralConfigKeyPath,
  valueAtKeys,
} from './text-shape.js';

interface TomlTableHeader {
  kind: 'table' | 'arrayTable';
  /** The header's own keys, `[a."b.c"]` → ['a', 'b.c']. */
  keys: string[];
  lineStart: number;
  statementEnd: number;
}

interface TomlKeyValue {
  /** Keys relative to the section, `a.b = 1` → ['a', 'b']. */
  keys: string[];
  lineStart: number;
  valueStart: number;
  valueEnd: number;
  /** Past the statement's line end (or the end of the text). */
  statementEnd: number;
}

interface TomlSection {
  header: TomlTableHeader | null;
  /** The keys values in this section sit under; an array table adds its element index. */
  fullKeys: string[];
  keyValues: TomlKeyValue[];
}

interface ScannedTomlDocument {
  text: string;
  sections: TomlSection[];
}

class TomlStructureError extends Error {}

function isTomlInlineSpace(character: string | undefined): boolean {
  return character === ' ' || character === '\t';
}

function isBareKeyCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || character === '_' || character === '-';
}

/** Past a `"…"` basic string whose opening quote is at `start` (single line). */
function endOfBasicString(text: string, start: number): number {
  let position = start + 1;
  while (position < text.length) {
    const character = text[position];
    if (character === '\\') {
      position += 2;
      continue;
    }
    if (character === '"') return position + 1;
    if (character === '\n') break;
    position++;
  }
  throw new TomlStructureError(`unterminated string at offset ${start}`);
}

/** Past a `'…'` literal string whose opening quote is at `start` (single line). */
function endOfLiteralString(text: string, start: number): number {
  for (let position = start + 1; position < text.length; position++) {
    if (text[position] === "'") return position + 1;
    if (text[position] === '\n') break;
  }
  throw new TomlStructureError(`unterminated string at offset ${start}`);
}

/** Past a `"""…"""` or `'''…'''` string; up to two extra quotes belong to the content. */
function endOfMultilineString(text: string, start: number): number {
  const delimiter = text.slice(start, start + 3);
  const quote = delimiter[0];
  let position = start + 3;
  while (position < text.length) {
    if (delimiter === '"""' && text[position] === '\\') {
      position += 2;
      continue;
    }
    if (text.startsWith(delimiter, position)) {
      let end = position + 3;
      while (end - position < 5 && text[end] === quote) end++;
      return end;
    }
    position++;
  }
  throw new TomlStructureError(`unterminated multi-line string at offset ${start}`);
}

function endOfAnyString(text: string, start: number): number {
  if (text.startsWith('"""', start) || text.startsWith("'''", start)) return endOfMultilineString(text, start);
  return text[start] === '"' ? endOfBasicString(text, start) : endOfLiteralString(text, start);
}

/** Past an array or inline table opening at `start`: strings, comments and nesting are skipped linearly. */
function endOfBracketedValue(text: string, start: number): number {
  let depth = 0;
  let position = start;
  while (position < text.length) {
    const character = text[position];
    if (character === '"' || character === "'") {
      position = endOfAnyString(text, position);
      continue;
    }
    if (character === '#') {
      while (position < text.length && text[position] !== '\n') position++;
      continue;
    }
    if (character === '[' || character === '{') depth++;
    if (character === ']' || character === '}') {
      depth--;
      if (depth === 0) return position + 1;
    }
    position++;
  }
  throw new TomlStructureError(`unterminated array or inline table at offset ${start}`);
}

function endOfTomlValue(text: string, start: number): number {
  const character = text[start];
  if (character === '"' || character === "'") return endOfAnyString(text, start);
  if (character === '[' || character === '{') return endOfBracketedValue(text, start);
  let position = start;
  while (position < text.length && !' \t\r\n#,]}'.includes(text[position])) position++;
  if (position === start) throw new TomlStructureError(`missing value at offset ${start}`);
  return position;
}

function decodeBasicStringKey(raw: string): string {
  let decoded = '';
  for (let position = 1; position < raw.length - 1; position++) {
    const character = raw[position];
    if (character !== '\\') {
      decoded += character;
      continue;
    }
    const escaped = raw[++position];
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
    if (escaped in simple) {
      decoded += simple[escaped];
    } else if (escaped === 'u' || escaped === 'U') {
      const length = escaped === 'u' ? 4 : 8;
      decoded += String.fromCodePoint(Number.parseInt(raw.slice(position + 1, position + 1 + length), 16));
      position += length;
    } else {
      throw new TomlStructureError(`bad escape in key ${raw}`);
    }
  }
  return decoded;
}

/** Parse a (dotted) key at `start`; stops before `terminator` (`=` or `]`). */
function parseTomlKeys(text: string, start: number): { keys: string[]; end: number } {
  const keys: string[] = [];
  let position = start;
  for (;;) {
    while (isTomlInlineSpace(text[position])) position++;
    const character = text[position];
    if (character === '"') {
      const end = endOfBasicString(text, position);
      keys.push(decodeBasicStringKey(text.slice(position, end)));
      position = end;
    } else if (character === "'") {
      const end = endOfLiteralString(text, position);
      keys.push(text.slice(position + 1, end - 1));
      position = end;
    } else {
      const keyStart = position;
      while (position < text.length && isBareKeyCharacter(text[position])) position++;
      if (position === keyStart) throw new TomlStructureError(`expected a key at offset ${keyStart}`);
      keys.push(text.slice(keyStart, position));
    }
    while (isTomlInlineSpace(text[position])) position++;
    if (text[position] !== '.') return { keys, end: position };
    position++;
  }
}

/** Past trailing spaces, an optional comment and the line end of a statement that ended at `position`. */
function endOfStatementLine(text: string, position: number): number {
  let index = position;
  while (isTomlInlineSpace(text[index])) index++;
  if (text[index] === '#') {
    while (index < text.length && text[index] !== '\n') index++;
  }
  if (text[index] === '\r') index++;
  if (index >= text.length) return text.length;
  if (text[index] !== '\n') throw new TomlStructureError(`expected the end of the line at offset ${index}`);
  return index + 1;
}

function lineStartOf(text: string, position: number): number {
  return text.lastIndexOf('\n', position - 1) + 1;
}

/** One linear pass: every table header and key/value statement, by section. */
function scanTomlStatements(text: string): ScannedTomlDocument {
  const sections: TomlSection[] = [{ header: null, fullKeys: [], keyValues: [] }];
  const arrayTableCounts = new Map<string, number>();
  let position = 0;
  while (position < text.length) {
    const character = text[position];
    if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
      position++;
      continue;
    }
    if (character === '#') {
      while (position < text.length && text[position] !== '\n') position++;
      continue;
    }
    const lineStart = lineStartOf(text, position);
    if (character === '[') {
      const isArrayTable = text[position + 1] === '[';
      const parsed = parseTomlKeys(text, position + (isArrayTable ? 2 : 1));
      const closer = isArrayTable ? ']]' : ']';
      if (!text.startsWith(closer, parsed.end)) throw new TomlStructureError(`expected ${closer} at offset ${parsed.end}`);
      const header: TomlTableHeader = {
        kind: isArrayTable ? 'arrayTable' : 'table',
        keys: parsed.keys,
        lineStart,
        statementEnd: endOfStatementLine(text, parsed.end + closer.length),
      };
      let fullKeys = parsed.keys;
      if (isArrayTable) {
        const countKey = JSON.stringify(parsed.keys);
        const elementIndex = arrayTableCounts.get(countKey) ?? 0;
        arrayTableCounts.set(countKey, elementIndex + 1);
        fullKeys = [...parsed.keys, String(elementIndex)];
      }
      sections.push({ header, fullKeys, keyValues: [] });
      position = header.statementEnd;
      continue;
    }
    const parsedKeys = parseTomlKeys(text, position);
    if (text[parsedKeys.end] !== '=') throw new TomlStructureError(`expected = at offset ${parsedKeys.end}`);
    let valueStart = parsedKeys.end + 1;
    while (isTomlInlineSpace(text[valueStart])) valueStart++;
    const valueEnd = endOfTomlValue(text, valueStart);
    const statementEnd = endOfStatementLine(text, valueEnd);
    sections[sections.length - 1].keyValues.push({ keys: parsedKeys.keys, lineStart, valueStart, valueEnd, statementEnd });
    position = statementEnd;
  }
  return { text, sections };
}

function pathKey(keys: readonly string[]): string {
  return JSON.stringify(keys);
}

function startsWithKeys(keys: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= keys.length && keysOverlap(keys, prefix);
}

/**
 * Definitions Bun's parser lets through: a table header written twice, and a
 * header for a table already made by a key/value (an inline table, a scalar,
 * or the tables dotted keys make).
 */
function assertTomlDefinitionsAreUnique(document: ScannedTomlDocument): void {
  const valuePaths = new Set<string>();
  const dottedKeyTables = new Set<string>();
  for (const section of document.sections) {
    for (const keyValue of section.keyValues) {
      const fullKeys = [...section.fullKeys, ...keyValue.keys];
      valuePaths.add(pathKey(fullKeys));
      for (let length = section.fullKeys.length + 1; length < fullKeys.length; length++) {
        dottedKeyTables.add(pathKey(fullKeys.slice(0, length)));
      }
    }
  }
  const tableHeaders = new Set<string>();
  for (const section of document.sections) {
    const header = section.header;
    if (!header) continue;
    const headerPath = pathKey(header.keys);
    const label = `[${header.kind === 'arrayTable' ? '[' : ''}${header.keys.join('.')}${header.kind === 'arrayTable' ? ']' : ''}]`;
    if (header.kind === 'table') {
      if (tableHeaders.has(headerPath)) throw new Error(`table ${label} is defined twice`);
      tableHeaders.add(headerPath);
    }
    if (dottedKeyTables.has(headerPath)) throw new Error(`table ${label} was already defined by dotted keys`);
    for (let length = 1; length <= header.keys.length; length++) {
      if (valuePaths.has(pathKey(header.keys.slice(0, length)))) {
        throw new Error(`table ${label} reopens "${header.keys.slice(0, length).join('.')}", which a key/value already defines`);
      }
    }
  }
}

function scanTomlForEdit(text: string): ScannedTomlDocument {
  try {
    return scanTomlStatements(text);
  } catch (error) {
    if (error instanceof TomlStructureError) throw new Error(`unsupported TOML layout (${error.message}); edit the file by hand`);
    throw error;
  }
}

/** Most dots one dotted key may hold. Real configs use a handful. */
export const MAX_TOML_DOTTED_KEY_DOTS = 128;

/**
 * Bun 1.3.9's TOML parser crashes the process (a segfault, not a throw) on a
 * dotted key of several thousand parts, also inside an inline table (probed).
 * Before Bun sees the text, refuse any run of more than
 * MAX_TOML_DOTTED_KEY_DOTS dots outside strings and comments; `=`, `,`, a
 * bracket, a brace or a line break ends a run, so floats count one dot each.
 * One linear pass.
 */
function assertTomlDottedKeysAreShort(text: string): void {
  let dotsInRun = 0;
  let position = 0;
  while (position < text.length) {
    const character = text[position];
    if (character === '"' || character === "'") {
      try {
        position = endOfAnyString(text, position);
      } catch (error) {
        throw new Error(`invalid TOML: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    if (character === '#') {
      while (position < text.length && text[position] !== '\n') position++;
      continue;
    }
    if (character === '.') {
      dotsInRun++;
      if (dotsInRun > MAX_TOML_DOTTED_KEY_DOTS) throw new Error(`a TOML key has more than ${MAX_TOML_DOTTED_KEY_DOTS} dotted parts; edit the file by hand`);
    } else if ('=,[]{}\n'.includes(character)) {
      dotsInRun = 0;
    }
    position++;
  }
}

/**
 * Parse with Bun and with the statement scanner; anything either refuses is
 * refused. Bun 1.3.9's parser is quadratic in the number of keys (20,000 keys
 * take about half a second), so a patch parses with it twice only: its input
 * and its exact output.
 */
function parseAndScanToml(text: string): { parsed: unknown; document: ScannedTomlDocument } {
  assertTomlDottedKeysAreShort(text);
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(`invalid TOML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const document = scanTomlForEdit(text);
  assertTomlDefinitionsAreUnique(document);
  return { parsed, document };
}

/**
 * A TOML basic string. Escapes from the TOML spec; other printable text,
 * non-ASCII included, is written as it is (magpie internal/edit/toml.go
 * `tomlString`).
 */
export function renderTomlString(value: string): string {
  let rendered = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    switch (character) {
      case '\b': rendered += '\\b'; break;
      // Bun 1.3.9 decodes `\t` as a form feed and `\f` as a tab (probed), so
      // these two go as \u escapes, which every TOML reader decodes alike.
      case '\t': rendered += '\\u0009'; break;
      case '\n': rendered += '\\n'; break;
      case '\f': rendered += '\\u000C'; break;
      case '\r': rendered += '\\r'; break;
      case '"': rendered += '\\"'; break;
      case '\\': rendered += '\\\\'; break;
      default:
        rendered += code < 0x20 || code === 0x7f ? `\\u${code.toString(16).toUpperCase().padStart(4, '0')}` : character;
    }
  }
  return `${rendered}"`;
}

function renderTomlKey(key: string): string {
  return key.length > 0 && [...key].every(isBareKeyCharacter) ? key : renderTomlString(key);
}

function renderTomlKeys(keys: readonly string[]): string {
  return keys.map(renderTomlKey).join('.');
}

function renderTomlValue(value: unknown, keyPath: string): string {
  if (typeof value === 'string') return renderTomlString(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : String(value);
  if (Array.isArray(value)) return `[${value.map((element) => renderTomlValue(element, keyPath)).join(', ')}]`;
  if (isPlainObjectValue(value)) {
    const entries = Object.entries(value).map(([key, entry]) => `${renderTomlKey(key)} = ${renderTomlValue(entry, keyPath)}`);
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
  }
  throw new Error(`${keyPath}: TOML has no null; delete the key instead`);
}

function spliceTomlText(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

/** Insert one statement line at `position` (a line start, or the end of the text). */
function insertTomlLine(text: string, position: number, line: string): string {
  if (position === text.length && text.length > 0 && !text.endsWith('\n')) return `${text}\n${line}`;
  return spliceTomlText(text, position, position, `${line}\n`);
}

function setTomlValue(text: string, keys: string[], value: unknown, keyPath: string): string {
  const document = scanTomlForEdit(text);
  const exact: TomlKeyValue[] = [];
  for (const section of document.sections) {
    for (const keyValue of section.keyValues) {
      const fullKeys = [...section.fullKeys, ...keyValue.keys];
      if (pathKey(fullKeys) === pathKey(keys)) exact.push(keyValue);
      else if (startsWithKeys(fullKeys, keys)) throw new Error(`${keyPath} is a table; set its keys one by one`);
      else if (startsWithKeys(keys, fullKeys)) throw new Error(`${keyPath}: "${fullKeys.join('.')}" is a value, not a table; edit the file by hand`);
    }
    if (section.header && startsWithKeys(section.fullKeys, keys)) throw new Error(`${keyPath} is a table; set its keys one by one`);
  }
  const rendered = renderTomlValue(value, keyPath);
  if (exact.length > 1) throw new Error(`${keyPath} is written more than once; edit the file by hand`);
  if (exact.length === 1) return spliceTomlText(text, exact[0].valueStart, exact[0].valueEnd, rendered);

  // The deepest table (or the root) the key belongs under.
  let host = document.sections[0];
  for (const section of document.sections) {
    if (section.fullKeys.length < keys.length && startsWithKeys(keys, section.fullKeys) && section.fullKeys.length > host.fullKeys.length) host = section;
  }
  const remainingKeys = keys.slice(host.fullKeys.length);
  const hostUsesDottedKeysFor = host.keyValues.some((keyValue) => keyValue.keys.length > 1 && keyValue.keys[0] === remainingKeys[0]);
  if (remainingKeys.length === 1 || hostUsesDottedKeysFor || host.header?.kind === 'arrayTable') {
    const line = `${renderTomlKeys(remainingKeys)} = ${rendered}`;
    const lastKeyValue = host.keyValues[host.keyValues.length - 1];
    const insertAt = lastKeyValue ? lastKeyValue.statementEnd : host.header ? host.header.statementEnd : 0;
    return insertTomlLine(text, insertAt, line);
  }
  // A new table, appended after a blank line.
  const block = `[${renderTomlKeys(keys.slice(0, -1))}]\n${renderTomlKey(keys[keys.length - 1])} = ${rendered}\n`;
  if (text === '') return block;
  return `${text}${text.endsWith('\n') ? '\n' : '\n\n'}${block}`;
}

/** Where the section ending before `nextHeaderLineStart` stops: comment lines right above a header belong to it. */
function sectionEndBefore(text: string, nextHeaderLineStart: number): number {
  let end = nextHeaderLineStart;
  while (end > 0) {
    const previousLineStart = lineStartOf(text, end - 1);
    if (!text.slice(previousLineStart, end).trimStart().startsWith('#')) break;
    end = previousLineStart;
  }
  return end;
}

function deleteTomlValue(text: string, keys: string[]): string {
  const document = scanTomlForEdit(text);
  const removals: Array<{ start: number; end: number }> = [];
  document.sections.forEach((section, sectionIndex) => {
    if (section.header && startsWithKeys(section.fullKeys, keys)) {
      const nextHeader = document.sections.slice(sectionIndex + 1).find((later) => later.header)?.header ?? null;
      const end = nextHeader ? sectionEndBefore(text, nextHeader.lineStart) : text.length;
      // Comment lines right above the header go with it.
      let start = sectionEndBefore(text, section.header.lineStart);
      // The last table goes with the blank line that set it apart.
      if (end === text.length && text.slice(0, start).endsWith('\n\n')) start--;
      removals.push({ start: Math.min(start, end), end });
      return;
    }
    for (const keyValue of section.keyValues) {
      if (!startsWithKeys([...section.fullKeys, ...keyValue.keys], keys)) continue;
      let start = keyValue.lineStart;
      // A last line with no line end takes the line end before it instead.
      if (keyValue.statementEnd === text.length && !text.endsWith('\n') && start > 0) start--;
      removals.push({ start, end: keyValue.statementEnd });
    }
  });
  // Ranges can touch (a blank line or line end taken from a neighbor): merge, then cut.
  const merged: Array<{ start: number; end: number }> = [];
  for (const removal of removals.sort((left, right) => left.start - right.start)) {
    const previous = merged[merged.length - 1];
    if (previous && removal.start <= previous.end) previous.end = Math.max(previous.end, removal.end);
    else merged.push({ ...removal });
  }
  let edited = text;
  for (const removal of merged.reverse()) {
    edited = spliceTomlText(edited, removal.start, removal.end, '');
  }
  return edited;
}

export interface TomlSetOperation {
  keyPath: string;
  value: unknown;
}

export interface TomlPatch {
  set?: TomlSetOperation[];
  delete?: string[];
}

/**
 * Apply sets, then deletes, to a TOML document and return its new bytes.
 * Only the edited statements change; comments, layout, a byte order mark and
 * all-CRLF line endings are kept. A set replaces a value in place, adds a
 * missing key after the last key of its table, or appends a new table. A
 * delete removes a key's line, or a whole table (with its sub-tables). A path
 * step that is a number picks an array table element (`hooks.0.event`).
 * Invalid input is refused, and the exact output is parsed and compared at
 * every edited path before it is returned.
 */
export function patchTomlDocument(originalBytes: Uint8Array, patch: TomlPatch): Uint8Array {
  return editConfigTextPreservingShape(originalBytes, (text) => {
    parseAndScanToml(text); // Refuse invalid input before anything else.
    const expectations: Array<{ keys: string[]; present: boolean; value?: unknown }> = [];
    let edited = text;
    for (const operation of patch.set ?? []) {
      assertPlainConfigValue(operation.value, operation.keyPath);
      const keys = splitLiteralConfigKeyPath(operation.keyPath);
      edited = setTomlValue(edited, keys, operation.value, operation.keyPath);
      expectations.push({ keys, present: true, value: operation.value });
    }
    for (const keyPath of patch.delete ?? []) {
      const keys = splitLiteralConfigKeyPath(keyPath);
      edited = deleteTomlValue(edited, keys);
      expectations.push({ keys, present: false });
    }
    let parsed: unknown;
    try {
      parsed = parseAndScanToml(edited).parsed;
    } catch (error) {
      throw new Error(`edited TOML is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    expectations.forEach((expectation, index) => {
      if (expectations.slice(index + 1).some((later) => keysOverlap(later.keys, expectation.keys))) return;
      const actual = valueAtKeys(parsed, expectation.keys);
      const holds = expectation.present ? Bun.deepEquals(actual, expectation.value, true) : actual === undefined;
      if (!holds) throw new Error(`edited TOML does not hold the edit at ${expectation.keys.join('.')}`);
    });
    return edited;
  });
}

/** The value at a key path (decoded by Bun.TOML.parse), or undefined. */
export function readTomlValueAtKeyPath(configBytes: Uint8Array, keyPath: string): unknown {
  const { parsed } = parseAndScanToml(decodeConfigText(configBytes));
  return valueAtKeys(parsed, splitLiteralConfigKeyPath(keyPath));
}
