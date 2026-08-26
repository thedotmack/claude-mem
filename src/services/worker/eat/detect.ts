import { existsSync, statSync } from 'fs';
import type { EatSource } from './types.js';

export function detectSource(input: string | undefined, hasStdin: boolean): EatSource {
  if (input === '-' || (input === undefined && hasStdin)) {
    return { kind: 'stdin', locator: 'stdin' };
  }
  if (input === undefined) {
    throw new Error('No input provided: pass a file, directory, URL, or text, or pipe stdin');
  }
  if (/^https?:\/\//.test(input)) {
    return { kind: 'url', locator: input };
  }
  if (existsSync(input) && statSync(input).isDirectory()) {
    return { kind: 'directory', locator: input };
  }
  if (existsSync(input)) {
    return { kind: 'file', locator: input };
  }
  return { kind: 'text', locator: input };
}
