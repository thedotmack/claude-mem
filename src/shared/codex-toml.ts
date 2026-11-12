/**
 * Reading Codex's config.toml by the same semantic table and key names Codex
 * uses, without changing how the user spelled them. Shared by the installer,
 * which also writes these keys, and by the hook, which only reads one.
 */

/** A header's trailing comment is not part of its name; quoted hashes are. */
export function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote !== null) {
      if (quote === '"' && character === '\\') index++;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

/** Preserve line indices while excluding multiline string contents from table/key recognition. */
export function tomlStructuralLines(lines: string[]): string[] {
  let multiline: '"""' | "'''" | null = null;
  return lines.map((line) => {
    const structural = multiline === null ? stripTomlComment(line) : '';
    let quote: '"' | "'" | null = null;
    for (let index = 0; index < line.length; index++) {
      if (multiline !== null) {
        if (multiline === '"""' && line[index] === '\\') {
          index++;
        } else if (line.startsWith(multiline, index)) {
          // TOML permits one or two quote characters immediately before the closing delimiter.
          const character = multiline[0];
          let count = 3;
          while (count < 5 && line[index + count] === character) count++;
          index += count - 1;
          multiline = null;
        }
      } else if (quote !== null) {
        if (quote === '"' && line[index] === '\\') index++;
        else if (line[index] === quote) quote = null;
      } else if (line[index] === '#') {
        break;
      } else if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
        multiline = line.slice(index, index + 3) as '"""' | "'''";
        index += 2;
      } else if (line[index] === '"' || line[index] === "'") {
        quote = line[index] as '"' | "'";
      }
    }
    return structural;
  });
}

/** Read semantic key names without changing their spelling in the user's document. */
export function tomlKeyPath(input: string): { keys: string[]; rest: string } | null {
  const keys: string[] = [];
  const escapes: Record<string, string> = { '"': '"', '\\': '\\', b: '\b', t: '\t', n: '\n', f: '\f', r: '\r' };
  while (true) {
    const part = /^[ \t]*(?:([A-Za-z0-9_-]+)|"((?:[^"\\\r\n]|\\(?:["\\btnfr]|u[\da-fA-F]{4}|U[\da-fA-F]{8}))*)"|'([^'\r\n]*)')[ \t]*/.exec(input);
    if (!part) return null;
    const name = part[1] ?? part[3] ?? part[2].replace(
      /\\(?:u([\da-fA-F]{4})|U([\da-fA-F]{8})|(["\\btnfr]))/g,
      (_escape, short: string | undefined, long: string | undefined, simple: string) =>
        short || long ? String.fromCodePoint(Number.parseInt(short ?? long!, 16)) : escapes[simple],
    );
    keys.push(name);
    input = input.slice(part[0].length);
    if (!input.startsWith('.')) return { keys, rest: input };
    input = input.slice(1);
  }
}

export function tomlTableKey(line: string): string | null {
  const table = /^\s*\[(?!\[)(.*)\]\s*$/.exec(line);
  const parsed = table ? tomlKeyPath(table[1]) : null;
  return parsed && !parsed.rest ? JSON.stringify(parsed.keys) : null;
}

/** Read the same semantic table/key names that the managed writer updates. */
export function readTomlBooleanInTable(content: string, header: string, key: string): boolean | undefined {
  const tableKey = tomlTableKey(header);
  let inTable = false;
  for (const line of tomlStructuralLines(content.split('\n'))) {
    if (/^\s*\[/.test(line)) {
      inTable = tableKey !== null && tomlTableKey(line) === tableKey;
      continue;
    }
    if (!inTable) continue;
    const parsed = tomlKeyPath(line);
    if (parsed?.keys.length !== 1 || parsed.keys[0] !== key) continue;
    const value = /^=\s*(true|false)\s*$/.exec(parsed.rest);
    if (value) return value[1] === 'true';
  }
  return undefined;
}
