// SPDX-License-Identifier: Apache-2.0
//
// One entry point over the Phase 7 editors for the wiring engine: read a
// value at a key path, or compute a file's edited bytes (no write), whatever
// the file's format. Writes happen only in the wiring engine, inside
// `atomically(...)`.

import { patchEnvDocument, readEnvValue } from '../edit/env-editor.js';
import { patchJsoncDocument, resolveJsoncKeyPath } from '../edit/jsonc-editor.js';
import { decodeConfigText, type ConfigPatch } from '../edit/text-shape.js';
import { patchTomlDocument, readTomlValueAtKeyPath } from '../edit/toml-editor.js';
import { patchYamlDocument, readYamlValueAtKeyPath } from '../edit/yaml-editor.js';
import type { AgentConfigFormat } from '../agents/types.js';

/** A key as one literal key-path segment: `.`, `\` and a lone `*` are escaped. */
export function escapeConfigKeySegment(key: string): string {
  const escaped = key.replace(/[\\.]/g, (character) => `\\${character}`);
  return escaped === '*' ? '\\*' : escaped;
}

export function joinConfigKeyPath(segments: readonly string[]): string {
  return segments.map(escapeConfigKeySegment).join('.');
}

// `key = 1979-05-27…` or `key = 07:32:00…` outside a string: a TOML date or
// time. Linear: `[^=#"'\n]*` cannot match the `=` after it, and `[ \t]*`
// cannot match the digit after it, so no two quantifiers compete.
const TOML_DATETIME_LINE = /^[^=#"'\n]*=[ \t]*(?:\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2})/m;

/**
 * Bun's TOML parser refuses valid TOML dates and times (probed on 1.3.9:
 * "Expected key but found -"), and every TOML edit is checked with it. Name
 * the cause and the fix instead of a parser message the user cannot act on.
 */
function explainTomlFailure(configFilePath: string, text: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const datetime = TOML_DATETIME_LINE.exec(text);
  if (datetime) {
    const lineNumber = text.slice(0, datetime.index).split('\n').length;
    return new Error(
      `${configFilePath} line ${lineNumber} holds a TOML date or time, which claude-mem's TOML checker (Bun.TOML) cannot read, `
      + 'so the file cannot be edited safely. Quote that value as a string or remove it, then run the command again; '
      + 'or point the agent at the gateway by hand with `claude-mem wire routes add`.',
    );
  }
  return new Error(`${configFilePath}: ${message}`);
}

/** The value at a literal key path (a `.env` key path is the variable name), or undefined. Throws on an unreadable file. */
export function readConfigValue(format: AgentConfigFormat, configFilePath: string, bytes: Uint8Array | null, keyPath: string): unknown {
  if (bytes === null) return undefined;
  switch (format) {
    case 'json': {
      const matches = resolveJsoncKeyPath(bytes, keyPath);
      return matches.length === 0 ? undefined : matches[matches.length - 1].value;
    }
    case 'toml':
      try {
        return readTomlValueAtKeyPath(bytes, keyPath);
      } catch (error) {
        throw explainTomlFailure(configFilePath, decodeConfigText(bytes), error);
      }
    case 'yaml':
      if (decodeConfigText(bytes).trim() === '') return undefined;
      return readYamlValueAtKeyPath(bytes, keyPath);
    case 'env':
      return readEnvValue(bytes, keyPath);
  }
}

/** The literal key paths a `*` path reaches in a JSON file (one per existing key). */
export function expandJsonWildcardKeyPath(bytes: Uint8Array | null, keyPath: string): Array<{ keyPath: string; keys: string[] }> {
  if (bytes === null) return [];
  return resolveJsoncKeyPath(bytes, keyPath).map((match) => ({ keyPath: joinConfigKeyPath(match.keys), keys: match.keys }));
}

/** The file's bytes after the patch (an absent file is edited from empty). Nothing is written. */
export function patchConfigBytes(format: AgentConfigFormat, configFilePath: string, bytes: Uint8Array | null, patch: ConfigPatch): Uint8Array {
  const originalBytes = bytes ?? new Uint8Array(0);
  switch (format) {
    case 'json':
      return patchJsoncDocument(originalBytes, patch);
    case 'toml':
      try {
        return patchTomlDocument(originalBytes, patch);
      } catch (error) {
        throw explainTomlFailure(configFilePath, decodeConfigText(originalBytes), error);
      }
    case 'yaml':
      return patchYamlDocument(originalBytes, patch);
    case 'env':
      return patchEnvDocument(originalBytes, {
        set: (patch.set ?? []).map(({ keyPath, value }) => {
          if (typeof value !== 'string') throw new Error(`${configFilePath}: ${keyPath} must be a string in a .env file`);
          return { key: keyPath, value };
        }),
        delete: patch.delete,
      });
  }
}

/** True when a file holds nothing but an empty document (what connect's own creation leaves after disconnect). */
export function isEmptyConfigDocument(bytes: Uint8Array): boolean {
  const text = decodeConfigText(bytes).trim();
  return text === '' || text === '{}';
}
