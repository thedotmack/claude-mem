// SPDX-License-Identifier: Apache-2.0
//
// A dotenv editor (plan Phase 7 task 6), ported from magpie
// internal/edit/env.go and text.go (MIT, Copyright (c) 2026 yetone): a set
// rewrites only its own line (the last one for a key set twice, which is the
// one dotenv readers use) or adds one after the last assignment; a delete
// drops every line for the key. Every other line is kept byte for byte.

import { applyConfigFileEdit, readConfigFileBytes, removeConfigFile } from './config-file.js';
import { decodeConfigText, editConfigTextPreservingShape } from './text-shape.js';

/**
 * magpie's `^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$`
 * without its `(.*?)\s*$` tail: a lazy group followed by `\s*$` backtracks
 * quadratically over a long run of spaces inside a value (a 1 MB line took
 * minutes). The value is everything after `=`, trimmed in code instead.
 */
const ENV_ASSIGNMENT_PATTERN = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/;

interface EnvAssignment {
  key: string;
  rawValue: string;
}

function parseEnvAssignment(line: string): EnvAssignment | null {
  const match = ENV_ASSIGNMENT_PATTERN.exec(line);
  if (!match) return null;
  return { key: match[1], rawValue: line.slice(match[0].length).trim() };
}

/** A leading quoted value, unquoted (anything after it, such as a comment, dropped); null when it is not quoted. */
function unquoteEnvValue(rawValue: string): string | null {
  const quote = rawValue[0];
  if (quote !== '"' && quote !== "'") return null;
  for (let index = 1; index < rawValue.length; index++) {
    if (quote === '"' && rawValue[index] === '\\') {
      index++;
      continue;
    }
    if (rawValue[index] === quote) {
      const inner = rawValue.slice(1, index);
      if (quote === "'") return inner;
      try {
        return JSON.parse(`"${inner}"`) as string;
      } catch {
        return inner;
      }
    }
  }
  return rawValue.slice(1);
}

/** The value a dotenv reader sees for `key` (the last assignment wins), or undefined. */
export function readEnvValue(configBytes: Uint8Array, key: string): string | undefined {
  const lines = decodeConfigText(configBytes).split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const assignment = parseEnvAssignment(lines[index]);
    if (!assignment || assignment.key !== key) continue;
    const unquoted = unquoteEnvValue(assignment.rawValue);
    if (unquoted !== null) return unquoted;
    const commentStart = assignment.rawValue.indexOf('#');
    return commentStart === -1 ? assignment.rawValue : assignment.rawValue.slice(0, commentStart).trim();
  }
  return undefined;
}

/** A value as dotenv text: bare when safe, else single- or double-quoted (Gemini CLI keeps backslashes literal in single quotes). */
function renderEnvValue(key: string, value: string): string {
  if (value.includes('\n') || value.includes('\r')) throw new Error(`${key}: a .env value cannot hold a line break here`);
  if (![' ', '#', '"', "'", '$', '\t'].some((special) => value.includes(special))) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function assertEnvKey(key: string): void {
  if (!/^[A-Za-z_]\w*$/.test(key)) throw new Error(`"${key}" is not a .env key`);
}

export interface EnvPatch {
  set?: Array<{ key: string; value: string }>;
  delete?: string[];
}

/**
 * Apply sets, then deletes, to a .env file and return its new bytes. A file
 * that does not end in a line break gets none added, so a set followed by a
 * delete of the same new key gives back the original bytes.
 */
export function patchEnvDocument(originalBytes: Uint8Array, patch: EnvPatch): Uint8Array {
  return editConfigTextPreservingShape(originalBytes, (text) => {
    let lines = text.split('\n');
    for (const { key, value } of patch.set ?? []) {
      assertEnvKey(key);
      const newLine = `${key}=${renderEnvValue(key, value)}`;
      let lastAssignment = -1;
      let sameKey = -1;
      lines.forEach((line, index) => {
        const assignment = parseEnvAssignment(line);
        if (!assignment) return;
        lastAssignment = index;
        if (assignment.key === key) sameKey = index;
      });
      if (sameKey !== -1) {
        lines[sameKey] = newLine;
        continue;
      }
      const insertAt = lastAssignment + 1;
      if (insertAt === lines.length) {
        // After a last line with no line break: the new line becomes the last one.
        lines = [...lines, newLine];
      } else {
        lines = [...lines.slice(0, insertAt), newLine, ...lines.slice(insertAt)];
      }
    }
    for (const key of patch.delete ?? []) {
      assertEnvKey(key);
      lines = lines.filter((line) => parseEnvAssignment(line)?.key !== key);
    }
    return lines.join('\n');
  });
}

/**
 * Delete keys from a .env file. When that leaves only whitespace and the
 * applied record says claude-mem created the file, the file itself goes
 * (magpie `DelEnvFile`); a file the user had is never removed.
 */
export function deleteEnvFileKeys(envFilePath: string, keys: string[], options: { fileWasCreatedByClaudeMem: boolean }): void {
  applyConfigFileEdit(envFilePath, (bytes) => patchEnvDocument(bytes, { delete: keys }));
  const remaining = readConfigFileBytes(envFilePath);
  if (options.fileWasCreatedByClaudeMem && remaining !== null && decodeConfigText(remaining).trim() === '') {
    removeConfigFile(envFilePath);
  }
}
