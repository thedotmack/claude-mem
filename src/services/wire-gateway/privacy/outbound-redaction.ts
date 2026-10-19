// SPDX-License-Identifier: Apache-2.0
//
// Outbound redaction (plan Phase 6 task 3; a route feature, off by default):
// the secrets in what an agent sends a vendor are swapped for placeholders
// like {{API_KEY_k3v9x2mq}}, and the vendor's reply has them swapped back
// (placeholder-restoring-response.ts), so the agent sees the real value and
// the vendor never does. Ported from magpie internal/redact (redact.go,
// known.go, json.go; MIT, Copyright (c) 2026 yetone), secrets only: magpie's
// personal-data categories, user words and user rules are not part of this
// feature.
//
// A placeholder is the same for the same value every time (a keyed hash), so
// a conversation's history reads the same turn after turn and what a vendor
// cached of it stays good. Values are held in memory only, by placeholder, as
// requests bring them; past 200,000 the oldest half is let go, and a request
// that still has them brings them back. A value once masked is masked
// wherever a request has it, whatever words are around it (magpie known.go).
//
// Masking edits only string values, by byte splices: every other byte goes
// upstream as the agent wrote it. Exemptions are by POSITION, never by a key
// name alone (magpie json.go `keepIn`):
// - what a vendor sealed (a thinking block's signature, Gemini's thought
//   signature, Responses' encrypted reasoning) goes back as written, except
//   that values already masked become their placeholders again;
// - a tool call's arguments are never exempt, whatever their keys are called;
// - in what the agent defines for the vendor (tools, schemas, settings) only
//   a `description` is masked.
// Wherever a string is not exempt, a field named for a secret (password,
// api_key, client_secret: isSecretFieldName, the list the on-disk scrub
// uses) has its whole value masked, as SECRET, whatever the value looks like.
// Nothing inside a signature value itself is ever touched.

import { createHmac, randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { WIRE_GATEWAY_DIR_MODE, WIRE_GATEWAY_FILE_MODE, paths } from '../../../shared/paths.js';
import { findSecretSpans, isSecretFieldName, replaceSecretSpans, type SecretSpan } from '../../../utils/redaction.js';
import { logger } from '../../../utils/logger.js';
import { applyByteSplices, type ByteSplice } from '../json/byte-splices.js';
import {
  collectJsonStrings,
  joinJsonPath,
  jsonEscapeString,
  rewriteJsonStringsInText,
  stringValueSplice,
  type JsonObjectSite,
} from '../json/string-walker.js';
import { JsonScanError, arrayElements, decodeString, objectMembers, scanDocument, type JsonObjectMember, type JsonSpan } from '../json/scanner.js';

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** Values held past this let the oldest half go (magpie `maxValues`). */
export const OUTBOUND_REDACTION_MAX_HELD_VALUES = 200_000;
/** The shortest value matched as known (magpie `minKnown`). */
const KNOWN_VALUE_MIN_LENGTH = 8;
/** The longest kind a placeholder may name (magpie `maxKind`). */
const PLACEHOLDER_KIND_MAX_LENGTH = 24;
/** The longest placeholder: {{, a kind, _, the 8 of the hash, }} (magpie `maxPlaceholder`). */
const PLACEHOLDER_MAX_LENGTH = 2 + PLACEHOLDER_KIND_MAX_LENGTH + 1 + 8 + 2;
const PLACEHOLDER_KEY_BYTES = 32;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The first 8 characters of base32 (RFC 4648, no padding) of `bytes`: 40 bits, the first 5 bytes. */
function base32First8(bytes: Uint8Array): string {
  let bits = 0;
  let bitCount = 0;
  let encoded = '';
  for (let index = 0; index < 5; index++) {
    bits = (bits << 8) | bytes[index];
    bitCount += 8;
    while (bitCount >= 5) {
      encoded += BASE32_ALPHABET[(bits >>> (bitCount - 5)) & 31];
      bitCount -= 5;
    }
  }
  return encoded;
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

function isAlphanumeric(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9]/.test(character);
}

/**
 * A placeholder's body as a model may write one back: a letter, then word
 * characters, `_`, and 8 of base32 in either case (magpie `placeholderBody`).
 * Checked on a whole word: a body inside a longer word is no placeholder.
 */
function isPlaceholderBody(word: string): boolean {
  if (word.length < 10 || !/[A-Za-z]/.test(word[0]) || word[word.length - 9] !== '_') return false;
  return /^[A-Za-z2-7]{8}$/.test(word.slice(-8));
}

/** The placeholder Mask wrote for `body`, whatever its case (magpie `canonical`). */
function canonicalPlaceholder(body: string): string {
  const hashStart = body.length - 8;
  return `{{${body.slice(0, hashStart).toUpperCase()}${body.slice(hashStart).toLowerCase()}}}`;
}

/** The kind in a placeholder: SECRET of {{SECRET_abcdefgh}} (magpie `kindOf`). */
function kindOfPlaceholder(placeholder: string): string {
  const underscore = placeholder.lastIndexOf('_');
  return underscore > 2 ? placeholder.slice(2, underscore) : '';
}

/**
 * magpie `standsAlone` for a secret: the known value is not a piece of a
 * longer one (no letter or digit pressed against a letter or digit of it).
 */
function knownValueStandsAlone(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  const after = text[end];
  return !(isAlphanumeric(before) && isAlphanumeric(text[start])) && !(isAlphanumeric(after) && isAlphanumeric(text[end - 1]));
}

/**
 * magpie `braces`: widen text[start, end), a placeholder's body, over the
 * braces the model wrote around it and the spaces inside them. A single
 * brace on one side alone is the text's own and stays.
 */
function widenOverBraces(text: string, start: number, end: number): [number, number] {
  let left = start;
  let leftBraces = 0;
  while (left > 0 && (text[left - 1] === ' ' || text[left - 1] === '\t')) left--;
  while (leftBraces < 2 && left > 0 && text[left - 1] === '{') {
    left--;
    leftBraces++;
  }
  let right = end;
  let rightBraces = 0;
  while (right < text.length && (text[right] === ' ' || text[right] === '\t')) right++;
  while (rightBraces < 2 && right < text.length && text[right] === '}') {
    right++;
    rightBraces++;
  }
  const widenedStart = leftBraces === 2 || (leftBraces === 1 && rightBraces >= 1) ? left : start;
  const widenedEnd = rightBraces === 2 || (rightBraces === 1 && leftBraces >= 1) ? right : end;
  return [widenedStart, widenedEnd];
}

/** Keys whose strings are the vendor's own ids, names, kinds or sealed/encoded data (magpie `kept`). */
const KEPT_KEYS = new Set([
  'signature', 'encrypted_content', 'data', 'thoughtSignature', 'thought_signature',
  'model', 'id', 'tool_use_id', 'call_id', 'item_id', 'type', 'role',
  'name', 'previous_response_id', 'prompt_cache_key', 'media_type', 'mime_type',
  'mimeType', 'url', 'image_url', 'file_id', 'reasoning_effort', 'effort',
  'stop_reason', 'finish_reason', 'status', 'object', 'event',
]);

/**
 * A reply string's path inside a tool call's arguments: Gemini's
 * functionCall.args, or the input of Anthropic's streamed tool_use block.
 * Keys there are the tool's own, never the vendor's.
 */
const REPLY_TOOL_ARGUMENTS_PATH = /(?:^|\.)(?:(?:functionCall|function_call)\.args|content_block\.input)\./;

/**
 * magpie `keep`: a reply's string left alone when restoring. As with masking,
 * the exemption is by position: a kept key's string is put back when it sits
 * in a tool call's arguments (a tool's `url`, `name`, `id` or `data`).
 */
export function isKeptReplyString(path: string, key: string, value: string): boolean {
  if (value.startsWith('data:')) return true;
  return KEPT_KEYS.has(key) && !REPLY_TOOL_ARGUMENTS_PATH.test(path);
}

/** A key holding an identifier the vendor matches against another (magpie `isID`). */
function isIdentifierKey(key: string): boolean {
  return key === 'id' || key === 'ids' || key.endsWith('_id') || key.endsWith('_ids') || key.endsWith('Id') || key.endsWith('Ids');
}

/** The keys of what a vendor seals the content beside it with (magpie `signatureKeys`). */
const SIGNATURE_KEYS = ['signature', 'thoughtSignature', 'thought_signature', 'encrypted_content'];

/** The request's own keys whose values the agent defines for the vendor to read as structure (magpie `defKeys`). */
const DEFINITION_KEYS = [
  'tools', 'tool_choice', 'functions', 'function_call', 'toolConfig', 'tool_config',
  'response_format', 'text', 'reasoning', 'include', 'output_format', 'output_config',
  'generationConfig', 'generation_config',
];

/** Responses input items that carry tools (magpie `defItems`). */
const DEFINITION_ITEM_TYPES = new Set(['additional_tools', 'tool_search_output']);

/** Where a request's string sits, for the exemptions. */
type RequestStringPosition = 'plain' | 'sealed' | 'tool_arguments';

function stringMember(bytes: Uint8Array, members: JsonObjectMember[], key: string): string {
  let found = '';
  for (const member of members) {
    if (member.key === key && member.value.type === 'string') found = decodeString(bytes, member.value);
  }
  return found;
}

/** magpie `sealed`: a part with a thought signature, or a thinking/reasoning block with a signature or encrypted content. */
function isSealedObject(bytes: Uint8Array, members: JsonObjectMember[]): boolean {
  const type = stringMember(bytes, members, 'type');
  for (const signatureKey of SIGNATURE_KEYS) {
    if (stringMember(bytes, members, signatureKey) === '') continue;
    if (signatureKey === 'thoughtSignature' || signatureKey === 'thought_signature'
      || type === 'thinking' || type === 'reasoning' || type.startsWith('reasoning.')) {
      return true;
    }
  }
  return false;
}

/**
 * magpie `definitions`: the paths at which the agent defines rather than says:
 * the request's own definition keys (Responses' `text` only when it is an
 * object), and the tools of Responses' tool-carrying input items.
 */
function definitionPaths(bytes: Uint8Array): string[] {
  const root = scanDocument(bytes);
  if (root.type !== 'object') return [];
  const members = [...objectMembers(bytes, root)];
  const present = new Map(members.map(member => [member.key, member.value]));
  const definitions: string[] = [];
  for (const key of DEFINITION_KEYS) {
    const value = present.get(key);
    if (!value) continue;
    if (key === 'text' && value.type !== 'object') continue;
    definitions.push(key);
  }
  const input = present.get('input');
  if (input?.type === 'array') {
    collectArrayObjects(bytes, input).forEach((item, index) => {
      if (item && DEFINITION_ITEM_TYPES.has(stringMember(bytes, item, 'type'))) {
        definitions.push(joinJsonPath(joinJsonPath('input', String(index)), 'tools'));
      }
    });
  }
  return definitions;
}

/** Each element of an array: its members when it is an object, else null. */
function collectArrayObjects(bytes: Uint8Array, arraySpan: JsonSpan): Array<JsonObjectMember[] | null> {
  const items: Array<JsonObjectMember[] | null> = [];
  for (const element of arrayElements(bytes, arraySpan)) {
    items.push(element.type === 'object' ? [...objectMembers(bytes, element)] : null);
  }
  return items;
}

/** magpie `under`: path is one of `roots` or inside one. */
function isUnder(path: string, roots: string[]): boolean {
  return roots.some(root => root === '' || path === root || path.startsWith(`${root}.`));
}

export interface OutboundRedactionPlaceholdersOptions {
  /** Where the placeholder key lives; defaults to <DATA_DIR>/wire-gateway/redact.key. */
  keyFilePath?: string;
  /** Test seam: how many values are held before the oldest half is let go. */
  maxHeldValues?: number;
}

interface KnownValue {
  value: string;
  placeholder: string;
  kind: string;
}

/** The placeholder table: the key, the values masked so far, and masking/restoring with them. */
export class OutboundRedactionPlaceholders {
  private readonly keyFilePath: string;
  private readonly maxHeldValues: number;
  private placeholderKey: Buffer | null = null;
  /** placeholder → value, oldest first. */
  private readonly valuesByPlaceholder = new Map<string, string>();
  /** The kinds placeholders were made of, for a word that may still become one (magpie `kinds`). */
  private readonly placeholderKinds = new Set<string>();
  /** Known values by their first 8 characters (magpie `known`). */
  private knownValuesByHead = new Map<string, KnownValue[]>();
  /** The first two characters of every known value, so most places in a text are passed over at once. */
  private knownValueFirstPairs = new Set<number>();

  constructor(options: OutboundRedactionPlaceholdersOptions = {}) {
    this.keyFilePath = options.keyFilePath ?? paths.wireGatewayRedactKey();
    this.maxHeldValues = options.maxHeldValues ?? OUTBOUND_REDACTION_MAX_HELD_VALUES;
  }

  /** How many values are held now. */
  get heldValueCount(): number {
    return this.valuesByPlaceholder.size;
  }

  /**
   * 32 random bytes kept at redact.key (0600) across restarts, so a placeholder
   * stays the same and what a vendor cached stays good (magpie `loadKey`).
   */
  private key(): Buffer {
    if (this.placeholderKey) return this.placeholderKey;
    if (existsSync(this.keyFilePath)) {
      // Owner-only, whoever made the file (a copy, a restore from backup).
      if (process.platform !== 'win32') chmodSync(this.keyFilePath, WIRE_GATEWAY_FILE_MODE);
      const stored = readFileSync(this.keyFilePath);
      if (stored.length >= PLACEHOLDER_KEY_BYTES) {
        this.placeholderKey = stored.subarray(0, PLACEHOLDER_KEY_BYTES);
        return this.placeholderKey;
      }
      logger.warn('WIRE', 'Outbound redaction key file is too short; writing a new key', { keyFilePath: this.keyFilePath });
    }
    const generated = randomBytes(PLACEHOLDER_KEY_BYTES);
    mkdirSync(dirname(this.keyFilePath), { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
    writeFileSync(this.keyFilePath, generated, { mode: WIRE_GATEWAY_FILE_MODE });
    if (process.platform !== 'win32') chmodSync(this.keyFilePath, WIRE_GATEWAY_FILE_MODE);
    this.placeholderKey = generated;
    return generated;
  }

  /** {{KIND_<first 8 of lower base32nopad(HMAC-SHA256(key, kind‖0x00‖value))>}}, remembered (magpie `placeholder`). */
  placeholderFor(kind: string, value: string): string {
    const digest = createHmac('sha256', this.key()).update(`${kind}\u0000${value}`, 'utf8').digest();
    const placeholder = `{{${kind}_${base32First8(digest).toLowerCase()}}}`;
    if (!this.valuesByPlaceholder.has(placeholder)) {
      if (this.valuesByPlaceholder.size >= this.maxHeldValues) {
        let released = 0;
        for (const heldPlaceholder of this.valuesByPlaceholder.keys()) {
          this.valuesByPlaceholder.delete(heldPlaceholder);
          if (++released >= this.maxHeldValues / 2) break;
        }
        this.reindexKnownValues();
      }
      this.valuesByPlaceholder.set(placeholder, value);
      this.placeholderKinds.add(kind);
      this.addKnownValue(placeholder, value);
    }
    return placeholder;
  }

  private addKnownValue(placeholder: string, value: string): void {
    if (value.length < KNOWN_VALUE_MIN_LENGTH) return;
    const kind = kindOfPlaceholder(placeholder);
    const head = value.slice(0, KNOWN_VALUE_MIN_LENGTH);
    const sameHead = this.knownValuesByHead.get(head) ?? [];
    const existing = sameHead.findIndex(known => known.value === value);
    if (existing >= 0) {
      // One value under two kinds: the same one wins whichever came first.
      if (placeholder < sameHead[existing].placeholder) sameHead[existing] = { value, placeholder, kind };
      return;
    }
    sameHead.push({ value, placeholder, kind });
    this.knownValuesByHead.set(head, sameHead);
    this.knownValueFirstPairs.add((value.charCodeAt(0) << 16) | value.charCodeAt(1));
  }

  private reindexKnownValues(): void {
    this.knownValuesByHead = new Map();
    this.knownValueFirstPairs = new Set();
    for (const [placeholder, value] of this.valuesByPlaceholder) this.addKnownValue(placeholder, value);
  }

  /** Where `text` has a value masked before, the longer where two start at the same place (magpie `knownSpans`). */
  private knownValueSpans(text: string): SecretSpan[] {
    if (this.knownValuesByHead.size === 0 || text.length < KNOWN_VALUE_MIN_LENGTH) return [];
    const spans: SecretSpan[] = [];
    for (let index = 0; index + KNOWN_VALUE_MIN_LENGTH <= text.length; index++) {
      if (!this.knownValueFirstPairs.has((text.charCodeAt(index) << 16) | text.charCodeAt(index + 1))) continue;
      const candidates = this.knownValuesByHead.get(text.slice(index, index + KNOWN_VALUE_MIN_LENGTH));
      if (!candidates) continue;
      let best: KnownValue | null = null;
      for (const candidate of candidates) {
        if (best && candidate.value.length <= best.value.length) continue;
        if (!text.startsWith(candidate.value, index) || !knownValueStandsAlone(text, index, index + candidate.value.length)) continue;
        best = candidate;
      }
      if (best) {
        spans.push({ start: index, end: index + best.value.length, kind: best.kind });
        index += best.value.length - 1;
      }
    }
    return spans;
  }

  /** magpie `mask` with secrets on: the detectors' findings, then known values, swapped by `put`. */
  private maskWith(text: string, put: (kind: string, value: string) => string): { text: string; maskedCount: number } {
    if (text.length < 3) return { text, maskedCount: 0 };
    const spans = [...findSecretSpans(text), ...this.knownValueSpans(text)];
    const { text: masked, replacedCount } = replaceSecretSpans(text, spans, put);
    return { text: masked, maskedCount: replacedCount };
  }

  /** The secrets in a text swapped for placeholders (magpie `Mask`). */
  maskText(text: string): { text: string; maskedCount: number } {
    return this.maskWith(text, (kind, value) => this.placeholderFor(kind, value));
  }

  /**
   * The secrets in a request body swapped for placeholders, by byte splices
   * of string values (magpie `MaskJSON`). A body that is not JSON is masked
   * as text. `changed` is false (and `bytes` the input) when nothing was masked.
   */
  maskRequestBody(bytes: Uint8Array): { bytes: Uint8Array; maskedCount: number; changed: boolean } {
    let definitions: string[];
    let sites;
    try {
      definitions = definitionPaths(bytes);
      // What an object is (sealed, its type) is read once per object, not once
      // per member: a wide object would otherwise cost members² reads.
      const objectFacts = new WeakMap<JsonObjectSite<RequestStringPosition>, { sealed: boolean; type: string }>();
      sites = collectJsonStrings<RequestStringPosition>(bytes, {
        rootContext: 'plain',
        contextOfMember: (object: JsonObjectSite<RequestStringPosition>, member: JsonObjectMember): RequestStringPosition => {
          if (object.context !== 'plain') return object.context;
          let facts = objectFacts.get(object);
          if (!facts) {
            facts = { sealed: isSealedObject(bytes, object.members), type: stringMember(bytes, object.members, 'type') };
            objectFacts.set(object, facts);
          }
          if (facts.sealed) return 'sealed';
          const type = facts.type;
          if ((member.key === 'input' && (type === 'tool_use' || type === 'server_tool_use'))
            || (member.key === 'args' && (object.key === 'functionCall' || object.key === 'function_call'))) {
            return 'tool_arguments';
          }
          return 'plain';
        },
      });
    } catch (error) {
      if (!(error instanceof JsonScanError)) throw error;
      return this.maskNonJsonBody(bytes);
    }

    /** magpie `keepIn`: data: values; never in tool arguments; only descriptions in definitions; ids and kept keys. */
    const isExempt = (path: string, key: string, value: string, position: RequestStringPosition): boolean => {
      if (value.startsWith('data:')) return true;
      if (position === 'tool_arguments') return false;
      if (isUnder(path, definitions)) return key !== 'description';
      return KEPT_KEYS.has(key) || isIdentifierKey(key);
    };

    const splices: ByteSplice[] = [];
    let maskedCount = 0;
    const maskedValues = new Map<string, string>();
    const remember = (kind: string, value: string): string => {
      const placeholder = this.placeholderFor(kind, value);
      if (!maskedValues.has(value)) maskedValues.set(value, placeholder);
      return placeholder;
    };
    /**
     * A string that is itself JSON (OpenAI's tool-call `arguments`, Responses'
     * function_call `arguments`): its secret-named fields are masked whole,
     * as in the body, since the key the walker sees is `arguments`. Every
     * other byte of it stays as the agent wrote it. Only under `arguments`:
     * restore puts a value back JSON-escaped there (valueHoldsJson), but raw
     * in `content` or `text`, where a decoded value with a backslash or quote
     * would come back as broken JSON.
     */
    const maskSecretFieldsInJsonText = (key: string, text: string): string => {
      if (key !== 'arguments' || !/^\s*[[{]/.test(text)) return text;
      const rewritten = rewriteJsonStringsInText(text, (_path, key, value) => {
        if (value === '' || value.startsWith('data:') || !isSecretFieldName(key) || isWholePlaceholder(value)) return value;
        maskedCount++;
        return remember('SECRET', value);
      });
      return rewritten.text;
    };
    const sealedSites: typeof sites = [];
    for (const site of sites) {
      if (isExempt(site.path, site.key, site.value, site.context)) continue;
      if (site.context === 'sealed') {
        sealedSites.push(site);
        continue;
      }
      if (site.value !== '' && isSecretFieldName(site.key) && !isWholePlaceholder(site.value)) {
        maskedCount++;
        splices.push(stringValueSplice(site.span, remember('SECRET', site.value)));
        continue;
      }
      const masked = this.maskWith(maskSecretFieldsInJsonText(site.key, site.value), remember);
      maskedCount += masked.maskedCount;
      if (masked.text !== site.value) splices.push(stringValueSplice(site.span, masked.text));
    }

    // What a vendor sealed goes back as the vendor wrote it: the values masked
    // elsewhere in this request become their placeholders again (that is
    // what the vendor wrote where the agent reads the value), as do secrets
    // masked before; nothing else in it is touched.
    const remask = maskedValues.size > 0 ? longestFirstReplacer(maskedValues) : null;
    for (const site of sealedSites) {
      let sealedText = site.value;
      if (remask) {
        const remasked = remask(sealedText);
        if (remasked !== sealedText) maskedCount++;
        sealedText = remasked;
      }
      const knownMasked = replaceSecretSpans(sealedText, this.knownValueSpans(sealedText), (kind, value) => this.placeholderFor(kind, value));
      maskedCount += knownMasked.replacedCount;
      if (knownMasked.text !== site.value) splices.push(stringValueSplice(site.span, knownMasked.text));
    }
    if (splices.length === 0) return { bytes, maskedCount, changed: false };
    return { bytes: applyByteSplices(bytes, splices), maskedCount, changed: true };
  }

  /**
   * A body that is not JSON, masked as text. Every byte outside a secret
   * stays as it came: UTF-8 text round-trips exactly; anything else (a
   * binary upload) is read byte for byte as Latin-1, where the detectors,
   * all ASCII, still find what they find, and is written back the same way.
   */
  private maskNonJsonBody(bytes: Uint8Array): { bytes: Uint8Array; maskedCount: number; changed: boolean } {
    let text: string;
    let encoding: 'utf8' | 'latin1' = 'utf8';
    try {
      text = strictUtf8Decoder.decode(bytes);
    } catch {
      encoding = 'latin1';
      text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
    }
    const masked = this.maskText(text);
    if (masked.maskedCount === 0) return { bytes, maskedCount: 0, changed: false };
    return { bytes: new Uint8Array(Buffer.from(masked.text, encoding)), maskedCount: masked.maskedCount, changed: true };
  }

  /**
   * The values put back in `text` (magpie `Restore`). `escaped` is for text
   * that is itself JSON (a tool call's arguments), where a value goes in
   * JSON-escaped. A placeholder the model rewrote (spaces inside the braces,
   * a brace or both dropped, another case) is put back too when what is left
   * names a placeholder made here.
   */
  restore(text: string, escaped: boolean): string {
    if (!text.includes('_') || this.valuesByPlaceholder.size === 0) return text;
    let restored = '';
    let last = 0;
    let index = 0;
    while (index < text.length) {
      if (!isWordCharacter(text[index])) {
        index++;
        continue;
      }
      let wordEnd = index;
      while (wordEnd < text.length && isWordCharacter(text[wordEnd])) wordEnd++;
      const word = text.slice(index, wordEnd);
      const wordStart = index;
      index = wordEnd;
      if (!isPlaceholderBody(word)) continue;
      const value = this.valuesByPlaceholder.get(canonicalPlaceholder(word));
      if (value === undefined) continue;
      const [start, end] = widenOverBraces(text, wordStart, wordEnd);
      if (start < last) continue;
      restored += text.slice(last, start) + (escaped ? jsonEscapeString(value) : value);
      last = end;
    }
    if (last === 0) return text;
    return restored + text.slice(last);
  }

  /** The values put back in a whole JSON reply (magpie `RestoreJSON`). */
  restoreJsonText(body: string): string {
    if (!body.includes('{{')) return body;
    let eventType = '';
    const result = rewriteJsonStringsInText(body, (path, key, value) => {
      if (path === 'type') eventType = value;
      return this.restore(value, valueHoldsJson(key, eventType));
    });
    return result.ok ? result.text : this.restore(body, false);
  }

  /**
   * How much of the end of `text` may be the start of a placeholder the next
   * piece of a stream finishes (magpie `partialTail`).
   */
  partialPlaceholderTailLength(text: string): number {
    const braceTail = this.braceTailLength(text);
    return braceTail > 0 ? braceTail : this.wordTailLength(text);
  }

  /** magpie `braceTail`: from { or {{ on, then spaces, a placeholder's body or its start, then spaces and one } at most. */
  private braceTailLength(text: string): number {
    let braceIndex = text.lastIndexOf('{');
    if (braceIndex < 0) return 0;
    if (braceIndex > 0 && text[braceIndex - 1] === '{') braceIndex--;
    const tail = text.slice(braceIndex);
    if (tail.length >= PLACEHOLDER_MAX_LENGTH + 4 || tail.includes('}}')) return 0;
    const body = tail.replace(/^\{+/, '').replace(/^[ \t]+/, '');
    if (body === '') return tail.length;
    if (!/[A-Za-z]/.test(body[0])) return 0;
    let wordEnd = 0;
    while (wordEnd < body.length && isWordCharacter(body[wordEnd])) wordEnd++;
    const rest = body.slice(wordEnd).replace(/^[ \t]+/, '');
    if (rest !== '' && rest !== '}') return 0;
    if (wordEnd < body.length && !isPlaceholderBody(body.slice(0, wordEnd))) return 0;
    return tail.length;
  }

  /** magpie `wordTail`: a last word that starts as a placeholder of a kind made here does, up to the 8 of its hash. */
  private wordTailLength(text: string): number {
    let wordStart = text.length;
    while (wordStart > 0 && isWordCharacter(text[wordStart - 1])) wordStart--;
    const word = text.slice(wordStart);
    if (word === '' || word.length > PLACEHOLDER_KIND_MAX_LENGTH + 9 || !/[A-Z]/.test(word[0])) return 0;
    const upperWord = word.toUpperCase();
    for (const kind of this.placeholderKinds) {
      const kindPrefix = `${kind}_`;
      if (kindPrefix.startsWith(upperWord)) return word.length;
      if (upperWord.startsWith(kindPrefix) && upperWord.length - kindPrefix.length <= 8
        && /^[a-z2-7]*$/.test(upperWord.slice(kindPrefix.length).toLowerCase())) {
        return word.length;
      }
    }
    return 0;
  }
}

/** `value` is one placeholder and nothing else, so it is not masked again. */
function isWholePlaceholder(value: string): boolean {
  return /^\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}$/.test(value);
}

/** A function that swaps each value for its placeholder, the longest value first where two start at the same place (magpie `replacerOf`). */
function longestFirstReplacer(placeholdersByValue: Map<string, string>): (text: string) => string {
  const values = [...placeholdersByValue.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return text => text.replace(pattern, value => placeholdersByValue.get(value) ?? value);
}

/** A string under `key` holds JSON text of its own, so a value put back in it goes in escaped (magpie `asJSON`). */
export function valueHoldsJson(key: string, eventType: string): boolean {
  return key === 'arguments' || key === 'partial_json' || (key === 'delta' && eventType.includes('arguments'));
}
