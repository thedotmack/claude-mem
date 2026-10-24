// SPDX-License-Identifier: Apache-2.0
//
// One config file open for a Library change: read values, set and delete
// them, and render the new bytes. Nothing is written here; the engine writes
// inside `atomically(...)`.
//
// JSON has two modes, so the ported installers keep their exact output and
// no user's own formatting is ever thrown away:
//   - canonical: the file is exactly what `JSON.stringify(value, null, 2)`
//     gives (with or without a final newline), or absent. Edits go to the
//     parsed value and the file is re-rendered that way, which is what every
//     pre-Library installer wrote, so their goldens hold byte for byte; and
//     re-rendering a canonical file changes nothing but the edited members.
//   - in place: anything else (comments, trailing commas, another indent,
//     a byte order mark). Each edit is a byte splice through the Phase 7
//     JSONC editor; the rest of the file keeps its bytes. An array entry is
//     added or removed as one element splice, never by rewriting the array,
//     so comments and the other entries' formatting inside it survive.
// TOML and YAML always go through the Phase 7 editors (in place).

import { appendJsoncArrayElement, blankJsoncCommentsAndTrailingCommas, patchJsoncDocument, removeJsoncArrayElement } from '../edit/jsonc-editor.js';
import { decodeConfigText } from '../edit/text-shape.js';
import { joinConfigKeyPath, patchConfigBytes } from '../wiring/config-document.js';
import type { JsonFileStyle, LibraryConfigFormat, LibraryValue } from './types.js';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

export interface ConfigSession {
  readonly path: string;
  readonly format: LibraryConfigFormat;
  readonly existedBefore: boolean;
  readonly originalBytes: Uint8Array | null;
  /** The parsed document as it is now (after the edits so far). */
  document(): unknown;
  get(keyPath: string[]): unknown;
  /** Set a value; returns the containers the set created (outermost first). */
  set(keyPath: string[], value: LibraryValue): string[][];
  delete(keyPath: string[]): void;
  /** Add `value` as the last element of the array at `keyPath` (which must exist). JSON only. */
  appendToArray(keyPath: string[], value: LibraryValue): void;
  /** Take element `index` out of the array at `keyPath`. JSON only. */
  removeFromArray(keyPath: string[], index: number): void;
  /** Put `value` in place of element `index` of the array at `keyPath`. JSON only. */
  replaceInArray(keyPath: string[], index: number, value: LibraryValue): void;
  /** The file's bytes now; null when the file did not exist and nothing was set. */
  render(): Uint8Array | null;
  changed(): boolean;
}

function valueAt(document: unknown, keyPath: string[]): unknown {
  let current: unknown = document;
  for (const key of keyPath) {
    if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)];
    else if (isPlainObject(current)) current = Object.hasOwn(current, key) ? current[key] : undefined;
    else return undefined;
  }
  return current;
}

/** Parse a JSON or JSONC document; an unreadable or non-object file throws (it is never written). */
function parseJsonDocument(path: string, bytes: Uint8Array): { document: Record<string, unknown>; text: string } {
  const text = decodeConfigText(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(utf8Decoder.decode(blankJsoncCommentsAndTrailingCommas(utf8Encoder.encode(text))));
    } catch (error) {
      throw new Error(`${path} is not JSON claude-mem can read (${error instanceof Error ? error.message : String(error)}); it is left as it is`);
    }
  }
  if (!isPlainObject(parsed)) throw new Error(`${path} is not a JSON object; it is left as it is`);
  return { document: parsed, text };
}

function startsWithByteOrderMark(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

type JsonOperation =
  | { op: 'set'; keyPath: string[]; value: LibraryValue }
  | { op: 'delete'; keyPath: string[] }
  | { op: 'append'; keyPath: string[]; value: LibraryValue }
  | { op: 'remove-element'; keyPath: string[]; index: number }
  | { op: 'replace-element'; keyPath: string[]; index: number; value: LibraryValue };

class JsonConfigSession implements ConfigSession {
  readonly format = 'json' as const;
  readonly existedBefore: boolean;
  /** Re-render with JSON.stringify (see the file comment). */
  readonly canonical: boolean;
  private current: Record<string, unknown>;
  private readonly operations: JsonOperation[] = [];

  constructor(readonly path: string, readonly originalBytes: Uint8Array | null, private readonly style: JsonFileStyle) {
    const blank = originalBytes === null || decodeConfigText(originalBytes).trim() === '';
    this.existedBefore = originalBytes !== null;
    if (blank) {
      // An empty file holds nothing to keep (agy creates mcp_config.json at 0 bytes).
      this.current = cloneValue(style.initialDocument ?? {}) as Record<string, unknown>;
      this.canonical = true;
      return;
    }
    const { document, text } = parseJsonDocument(path, originalBytes!);
    this.current = document;
    this.canonical = !startsWithByteOrderMark(originalBytes!) && text.replace(/\n$/, '') === JSON.stringify(document, null, 2);
  }

  document(): unknown {
    return this.current;
  }

  get(keyPath: string[]): unknown {
    return valueAt(this.current, keyPath);
  }

  set(keyPath: string[], value: LibraryValue): string[][] {
    const created: string[][] = [];
    let container: Record<string, unknown> = this.current;
    for (let index = 0; index < keyPath.length - 1; index++) {
      const key = keyPath[index];
      const next = container[key];
      if (next === undefined) {
        container[key] = {};
        created.push(keyPath.slice(0, index + 1));
      } else if (!isPlainObject(next)) {
        throw new Error(`${this.path}: ${keyPath.slice(0, index + 1).join('.')} is not an object; it is left as it is`);
      }
      container = container[key] as Record<string, unknown>;
    }
    container[keyPath[keyPath.length - 1]] = cloneValue(value);
    this.operations.push({ op: 'set', keyPath, value: cloneValue(value) });
    return created;
  }

  delete(keyPath: string[]): void {
    const parent = valueAt(this.current, keyPath.slice(0, -1));
    const key = keyPath[keyPath.length - 1];
    if (!isPlainObject(parent) || !Object.hasOwn(parent, key)) return;
    delete parent[key];
    this.operations.push({ op: 'delete', keyPath });
  }

  private arrayAt(keyPath: string[]): unknown[] {
    const value = valueAt(this.current, keyPath);
    if (!Array.isArray(value)) throw new Error(`${this.path}: ${keyPath.join('.')} is not an array; it is left as it is`);
    return value;
  }

  appendToArray(keyPath: string[], value: LibraryValue): void {
    this.arrayAt(keyPath).push(cloneValue(value));
    this.operations.push({ op: 'append', keyPath, value: cloneValue(value) });
  }

  removeFromArray(keyPath: string[], index: number): void {
    const array = this.arrayAt(keyPath);
    if (index < 0 || index >= array.length) throw new Error(`${this.path}: ${keyPath.join('.')} has no element ${index}`);
    array.splice(index, 1);
    this.operations.push({ op: 'remove-element', keyPath, index });
  }

  replaceInArray(keyPath: string[], index: number, value: LibraryValue): void {
    const array = this.arrayAt(keyPath);
    if (index < 0 || index >= array.length) throw new Error(`${this.path}: ${keyPath.join('.')} has no element ${index}`);
    array[index] = cloneValue(value);
    this.operations.push({ op: 'replace-element', keyPath, index, value: cloneValue(value) });
  }

  changed(): boolean {
    return this.operations.length > 0;
  }

  render(): Uint8Array | null {
    if (!this.changed()) return this.originalBytes;
    if (this.canonical) {
      return utf8Encoder.encode(JSON.stringify(this.current, null, 2) + (this.style.finalNewline ? '\n' : ''));
    }
    let bytes: Uint8Array = this.originalBytes!;
    for (const operation of this.operations) {
      const keyPath = joinConfigKeyPath(operation.keyPath);
      if (operation.op === 'set') bytes = patchJsoncDocument(bytes, { set: [{ keyPath, value: operation.value }] });
      else if (operation.op === 'delete') bytes = patchJsoncDocument(bytes, { delete: [keyPath] });
      else if (operation.op === 'append') bytes = appendJsoncArrayElement(bytes, keyPath, operation.value);
      else if (operation.op === 'replace-element') bytes = patchJsoncDocument(bytes, { set: [{ keyPath: joinConfigKeyPath([...operation.keyPath, String(operation.index)]), value: operation.value }] });
      else bytes = removeJsoncArrayElement(bytes, keyPath, operation.index);
    }
    return bytes;
  }
}

/** TOML and YAML: every edit is a Phase 7 in-place patch, checked by the editor before it is kept. */
class StructuredTextConfigSession implements ConfigSession {
  readonly existedBefore: boolean;
  private bytes: Uint8Array | null;

  constructor(readonly path: string, readonly format: 'toml' | 'yaml', readonly originalBytes: Uint8Array | null) {
    this.existedBefore = originalBytes !== null;
    this.bytes = originalBytes;
    // Read once now so an unreadable file refuses before anything is planned.
    try {
      this.document();
    } catch (error) {
      throw new Error(`${path} is not ${format.toUpperCase()} claude-mem can read (${error instanceof Error ? error.message : String(error)}); it is left as it is`);
    }
  }

  document(): unknown {
    if (this.bytes === null) return {};
    const text = decodeConfigText(this.bytes);
    if (text.trim() === '') return {};
    return this.format === 'toml' ? Bun.TOML.parse(text) : Bun.YAML.parse(text);
  }

  get(keyPath: string[]): unknown {
    return valueAt(this.document(), keyPath);
  }

  set(keyPath: string[], value: LibraryValue): string[][] {
    const created: string[][] = [];
    for (let index = 1; index < keyPath.length; index++) {
      if (this.get(keyPath.slice(0, index)) === undefined) created.push(keyPath.slice(0, index));
    }
    this.bytes = patchConfigBytes(this.format, this.path, this.bytes, { set: [{ keyPath: joinConfigKeyPath(keyPath), value }], delete: [] });
    return created;
  }

  delete(keyPath: string[]): void {
    if (this.get(keyPath) === undefined) return;
    this.bytes = patchConfigBytes(this.format, this.path, this.bytes, { set: [], delete: [joinConfigKeyPath(keyPath)] });
  }

  appendToArray(): void {
    throw new Error(`${this.path}: array entries are written to JSON files only`);
  }

  removeFromArray(): void {
    throw new Error(`${this.path}: array entries are written to JSON files only`);
  }

  replaceInArray(): void {
    throw new Error(`${this.path}: array entries are written to JSON files only`);
  }

  changed(): boolean {
    if (this.bytes === this.originalBytes) return false;
    if (this.bytes === null || this.originalBytes === null) return true;
    return Buffer.compare(Buffer.from(this.bytes), Buffer.from(this.originalBytes)) !== 0;
  }

  render(): Uint8Array | null {
    return this.bytes;
  }
}

export function openConfigSession(path: string, format: LibraryConfigFormat, originalBytes: Uint8Array | null, style: JsonFileStyle = { finalNewline: true }): ConfigSession {
  return format === 'json' ? new JsonConfigSession(path, originalBytes, style) : new StructuredTextConfigSession(path, format, originalBytes);
}

/** True for `{}` and `[]`: what a remove leaves in a container claude-mem created. */
export function isEmptyContainer(value: unknown): boolean {
  return (Array.isArray(value) && value.length === 0) || (isPlainObject(value) && Object.keys(value).length === 0);
}
