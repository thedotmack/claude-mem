import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  deriveLineAnchors,
  findLineAnchor,
  indexFileLines,
  LINE_ANCHOR_MAX_FILE_BYTES,
  LINE_ANCHORS_METADATA_KEY,
  lineAnchorStateOf,
  lineAnchorsForObservation,
  MAX_LINE_ANCHORS_PER_OBSERVATION,
  normalizeLineAnchorPath,
  readLineAnchors,
  withLineAnchors,
  type LineAnchor,
  type LineAnchorMessage,
} from '../../src/shared/line-anchors.js';
import { stripMemoryTags } from '../../src/utils/tag-stripping.js';

const CHARGE_LINES = [
  "import { retry } from './retry';",
  '',
  'export const MAX_CHARGE_RETRIES = 3;',
  '',
  'export function chargeCard(card: Card) {',
  '  if (!card.token) {',
  "    throw new ChargeDeclined('missing token');",
  '  }',
  '  return retry(() => gateway.charge(card), MAX_CHARGE_RETRIES);',
  '}',
  '',
];
const CHARGE = CHARGE_LINES.join('\n');

/** What the worker stores for a Claude Code Read: the tool response as JSON text. */
function storedReadResponse(filePath: string, lines: string[]): string {
  return JSON.stringify({ type: 'text', file: { filePath, content: lines.join('\n'), numLines: lines.length } });
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'line-anchors-test-'));
  file = join(dir, 'charge.ts');
  writeFileSync(file, CHARGE);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const edit = (toolInput: Record<string, unknown>, extra: Partial<LineAnchorMessage> = {}): LineAnchorMessage => ({
  type: 'observation', tool_name: 'Edit', tool_input: { file_path: file, ...toolInput }, ...extra,
});

describe('deriveLineAnchors: what is captured', () => {
  it('anchors the line an Edit changed, preferring it over unchanged context lines', () => {
    const anchors = deriveLineAnchors([edit({
      old_string: "import { retry } from './retry';\n\nexport const MAX_CHARGE_RETRIES = 2;",
      new_string: "import { retry } from './retry';\n\nexport const MAX_CHARGE_RETRIES = 3;",
    })]);
    expect(anchors).toEqual([{ path: file, line: 3, text: 'export const MAX_CHARGE_RETRIES = 3;' }]);
  });

  it('skips lines that are not distinctive and lines that occur more than once', () => {
    writeFileSync(file, `${CHARGE}export const MAX_CHARGE_RETRIES = 3;\nexport const CHARGE_TIMEOUT_MS = 30000;\n`);
    const anchors = deriveLineAnchors([edit({
      new_string: '}\nexport const MAX_CHARGE_RETRIES = 3;\nexport const CHARGE_TIMEOUT_MS = 30000;',
    })]);
    // `}` has too few letters; the constant now occurs twice: the next unique line is the anchor.
    expect(anchors).toEqual([{ path: file, line: 12, text: 'export const CHARGE_TIMEOUT_MS = 30000;' }]);
  });

  it('never anchors a copy of an edit\'s line elsewhere in the file, only a line inside the text it wrote', () => {
    // The model sent the edit without the line's indentation and `self.`, so
    // new_string is part of line 6, and also all of line 2.
    writeFileSync(file, [
      'import logging',
      'logger = logging.getLogger(__name__)',
      '',
      'class Service:',
      '    def configure(self, level):',
      '        self.logger = logging.getLogger(__name__)',
      '        self.logger.setLevel(level)',
      '',
    ].join('\n'));
    // Found in two places, the text cannot say which line the edit wrote.
    expect(deriveLineAnchors([edit({
      old_string: 'logger = logging.getLogger("svc")',
      new_string: 'logger = logging.getLogger(__name__)',
    })])).toEqual([]);
    // With the next line it is found once, at lines 6-7: line 2 lies outside, so
    // the anchor is the next distinctive line the edit wrote.
    expect(deriveLineAnchors([edit({
      old_string: 'logger = logging.getLogger("svc")\n        self.logger.setLevel(level)',
      new_string: 'logger = logging.getLogger(__name__)\n        self.logger.setLevel(level)',
    })])).toEqual([{ path: file, line: 7, text: '        self.logger.setLevel(level)' }]);
  });

  it('finds an edit\'s text in a file with CRLF line endings', () => {
    writeFileSync(file, CHARGE.replace(/\n/g, '\r\n'));
    expect(deriveLineAnchors([edit({
      old_string: '  if (!card) {',
      new_string: "  if (!card.token) {\n    throw new ChargeDeclined('missing token');",
    })])).toEqual([{ path: file, line: 6, text: '  if (!card.token) {' }]);
  });

  it('never anchors a line whose text, whitespace ignored, occurs elsewhere: finding it again could land on that copy', () => {
    writeFileSync(file, [
      'export function totalFor(order: Order) {',
      '  const result = sumLines(order);',
      '  return result;',
      '}',
      'export class Invoice {',
      '  render() {',
      '    const result = sumLines(this.order);',
      '    return result;',
      '  }',
      '}',
      '',
    ].join('\n'));
    // Line 8 is the only `    return result;`, but line 3 squashes to the same text.
    expect(deriveLineAnchors([edit({ old_string: '    return result * 1;', new_string: '    return result;' })])).toEqual([]);
    // The next line the edit wrote that is unique either way is the anchor instead.
    expect(deriveLineAnchors([edit({
      old_string: '    const result = sumLines(this.order);\n    return result * 1;',
      new_string: '    const result = sumLines(this.order);\n    return result;',
    })])).toEqual([{ path: file, line: 7, text: '    const result = sumLines(this.order);' }]);
  });

  it('skips a line over 400 characters', () => {
    const long = `export const TABLE = '${'x'.repeat(420)}';`;
    writeFileSync(file, `${CHARGE}${long}\n`);
    expect(deriveLineAnchors([edit({ new_string: long })])).toEqual([]);
  });

  it('anchors each edit of a MultiEdit, and reads a JSON-string tool_input', () => {
    const anchors = deriveLineAnchors([{
      type: 'observation',
      tool_name: 'MultiEdit',
      tool_input: JSON.stringify({
        file_path: file,
        edits: [
          { old_string: 'a', new_string: "    throw new ChargeDeclined('missing token');" },
          { old_string: 'b', new_string: '  return retry(() => gateway.charge(card), MAX_CHARGE_RETRIES);' },
        ],
      }),
    }]);
    expect(anchors.map(anchor => anchor.line)).toEqual([7, 9]);
  });

  it('anchors a targeted Read at the first distinctive line of its window that the stored response holds', () => {
    const anchors = deriveLineAnchors([{
      type: 'observation',
      tool_name: 'Read',
      tool_input: { file_path: file, offset: 6, limit: 4 },
      tool_response: storedReadResponse(file, CHARGE_LINES.slice(5, 9)),
    }]);
    expect(anchors).toEqual([{ path: file, line: 6, text: '  if (!card.token) {' }]);
  });

  it('skips whole-file Reads, Reads from line 1, Writes, other tools and non-observation messages', () => {
    const response = storedReadResponse(file, CHARGE_LINES);
    expect(deriveLineAnchors([
      { type: 'observation', tool_name: 'Read', tool_input: { file_path: file }, tool_response: response },
      { type: 'observation', tool_name: 'Read', tool_input: { file_path: file, offset: 1, limit: 5 }, tool_response: response },
      { type: 'observation', tool_name: 'Write', tool_input: { file_path: file, content: CHARGE } },
      { type: 'observation', tool_name: 'edit_file', tool_input: { file_path: file, new_string: 'export const MAX_CHARGE_RETRIES = 3;' } },
      { type: 'summarize', tool_name: 'Edit', tool_input: { file_path: file, new_string: 'export const MAX_CHARGE_RETRIES = 3;' } },
    ])).toEqual([]);
  });

  it('resolves a relative path against the call\'s cwd and stores it as the tool spelled it', () => {
    const anchors = deriveLineAnchors([{
      type: 'observation', tool_name: 'Edit', cwd: dir,
      tool_input: { file_path: 'charge.ts', new_string: 'export function chargeCard(card: Card) {' },
    }]);
    expect(anchors).toEqual([{ path: 'charge.ts', line: 5, text: 'export function chargeCard(card: Card) {' }]);
  });

  it('skips a relative path without the call\'s cwd, never resolving it against the worker\'s', () => {
    const previous = process.cwd();
    process.chdir(dir);
    try {
      expect(deriveLineAnchors([{
        type: 'observation', tool_name: 'Edit',
        tool_input: { file_path: 'charge.ts', new_string: 'export function chargeCard(card: Card) {' },
      }])).toEqual([]);
    } finally {
      process.chdir(previous);
    }
  });

  it('skips missing files, files over LINE_ANCHOR_MAX_FILE_BYTES and files holding a NUL byte', () => {
    const line = 'export function chargeCard(card: Card) {';
    const oversized = join(dir, 'oversized.ts');
    writeFileSync(oversized, `${line}\n${'/'.repeat(LINE_ANCHOR_MAX_FILE_BYTES)}`);
    const binary = join(dir, 'binary.ts');
    writeFileSync(binary, `${line}\n\u0000\n`);
    expect(deriveLineAnchors([
      edit({ file_path: join(dir, 'gone.ts'), new_string: line }),
      edit({ file_path: oversized, new_string: line }),
      edit({ file_path: binary, new_string: line }),
    ])).toEqual([]);
  });

  it('records each line once, however many calls touched it', () => {
    const anchors = deriveLineAnchors([
      edit({ new_string: 'export const MAX_CHARGE_RETRIES = 3;' }),
      edit({ new_string: 'export const MAX_CHARGE_RETRIES = 3;' }),
    ]);
    expect(anchors).toHaveLength(1);
  });
});

describe('deriveLineAnchors: privacy', () => {
  const readAt = (offset: number, limit: number, responseLines: string[]): LineAnchorMessage => ({
    type: 'observation', tool_name: 'Read', tool_input: { file_path: file, offset, limit },
    tool_response: storedReadResponse(file, responseLines),
  });

  it('never records a Read line the stored response lacks: <private> content stripped at ingest', () => {
    const secret = '  const apiKey = loadKeyFromVault("payments-prod");';
    writeFileSync(file, [...CHARGE_LINES.slice(0, 4), secret, ...CHARGE_LINES.slice(4)].join('\n'));
    // The worker stored the response with the <private> span already removed.
    const anchors = deriveLineAnchors([readAt(5, 3, ['', 'export function chargeCard(card: Card) {'])]);
    expect(anchors).toEqual([{ path: file, line: 6, text: 'export function chargeCard(card: Card) {' }]);
    expect(JSON.stringify(anchors)).not.toContain('loadKeyFromVault');
  });

  it('never records a Read line whose secret was redacted in the stored response', () => {
    // CHARGE ends with a newline, so the key is line 11, the Read's whole window.
    writeFileSync(file, `${CHARGE}const STRIPE_KEY = 'not-a-real-key-0123456789abcdef';\n`);
    const anchors = deriveLineAnchors([readAt(11, 1, ["const STRIPE_KEY = '[REDACTED]';"])]);
    expect(anchors).toEqual([]);
  });

  it('never records a Read line that changed after the Read', () => {
    // The Read returned the old line; the file on disk now holds a different one.
    const anchors = deriveLineAnchors([readAt(3, 1, ['export const MAX_CHARGE_RETRIES = 2;'])]);
    expect(anchors).toEqual([]);
  });

  it('never records a <private> line whose text the stored response holds only inside a longer line', () => {
    const lines = [
      'export function closeBooks(ledger: Ledger) {',
      '  // <private>',
      '  settleLedger(ledger);',
      '  // </private>',
      '  settleLedger(ledger); // retry once',
      '  return ledger.close();',
      '}',
      '',
    ];
    writeFileSync(file, lines.join('\n'));
    // Claude Code's Read response for lines 2-6, stored as the worker stores it: stripped JSON text.
    const stored = stripMemoryTags(JSON.stringify({ type: 'text', file: { filePath: file, content: lines.slice(1, 6).join('\n') } }));
    expect(stored).not.toContain('\\n  settleLedger(ledger);\\n');
    const anchors = deriveLineAnchors([{
      type: 'observation', tool_name: 'Read', tool_input: { file_path: file, offset: 2, limit: 5 }, tool_response: stored,
    }]);
    expect(anchors).toEqual([{ path: file, line: 5, text: '  settleLedger(ledger); // retry once' }]);
  });

  it('records nothing for a Read whose stored response is no longer JSON: no line can be told apart from part of one', () => {
    const truncated = storedReadResponse(file, CHARGE_LINES.slice(4, 7)).slice(0, -2);
    expect(deriveLineAnchors([{
      type: 'observation', tool_name: 'Read', tool_input: { file_path: file, offset: 5, limit: 3 }, tool_response: truncated,
    }])).toEqual([]);
  });

  it('reads a Read result in a transcript\'s cat -n form, line numbers and all', () => {
    const numbered = CHARGE_LINES.slice(4, 7).map((line, index) => `${String(index + 5).padStart(6)}→${line}`).join('\n');
    const anchors = deriveLineAnchors([
      { type: 'observation', tool_name: 'Read', tool_input: { file_path: file, offset: 5, limit: 3 }, tool_response: JSON.stringify(numbered) },
      {
        type: 'observation', tool_name: 'Read', tool_input: { file_path: file, offset: 9, limit: 1 },
        tool_response: JSON.stringify([{ type: 'text', text: `     9\t${CHARGE_LINES[8]}` }]),
      },
    ]);
    expect(anchors.map(anchor => anchor.line)).toEqual([5, 9]);
  });

  it('records nothing for a Read whose stored response is missing or not text', () => {
    expect(deriveLineAnchors([
      { type: 'observation', tool_name: 'Read', tool_input: { file_path: file, offset: 5, limit: 3 } },
      { type: 'observation', tool_name: 'Read', tool_input: { file_path: file, offset: 5, limit: 3 }, tool_response: { file: { content: CHARGE } } },
    ])).toEqual([]);
  });

  it('never records an Edit line whose stored new_string was redacted', () => {
    writeFileSync(file, `${CHARGE}const STRIPE_KEY = 'not-a-real-key-0123456789abcdef';\n`);
    expect(deriveLineAnchors([edit({ new_string: "const STRIPE_KEY = '[REDACTED]';" })])).toEqual([]);
  });
});

describe('lineAnchorsForObservation', () => {
  const anchors: LineAnchor[] = [
    { path: 'src\\charge.ts', line: 3, text: 'a' },
    { path: 'src/other.ts', line: 1, text: 'b' },
  ];

  it('keeps the anchors on files the observation names, separators normalized', () => {
    expect(lineAnchorsForObservation({ files_modified: ['src/charge.ts'] }, anchors)).toEqual([anchors[0]]);
    expect(lineAnchorsForObservation({ files_read: ['./src/other.ts'] }, anchors)).toEqual([anchors[1]]);
    expect(lineAnchorsForObservation({ files_read: ['src/nowhere.ts'] }, anchors)).toEqual([]);
  });

  it(`keeps at most ${MAX_LINE_ANCHORS_PER_OBSERVATION}, giving every named file one before any file gets a second`, () => {
    const many: LineAnchor[] = [
      ...Array.from({ length: 4 }, (_, index) => ({ path: 'a.ts', line: index + 1, text: `a${index}` })),
      { path: 'b.ts', line: 1, text: 'b0' },
      { path: 'c.ts', line: 1, text: 'c0' },
    ];
    const picked = lineAnchorsForObservation({ files_read: ['a.ts', 'b.ts'], files_modified: ['c.ts'] }, many);
    expect(picked.map(anchor => anchor.text)).toEqual(['a0', 'b0', 'c0']);
    expect(lineAnchorsForObservation({ files_modified: ['a.ts'] }, many)).toHaveLength(MAX_LINE_ANCHORS_PER_OBSERVATION);
  });
});

describe('metadata', () => {
  const anchor: LineAnchor = { path: 'a.ts', line: 2, text: 'export const x = 1;' };

  it(`stores anchors under ${LINE_ANCHORS_METADATA_KEY}, keeping every other key`, () => {
    expect(JSON.parse(withLineAnchors(null, [anchor])!)).toEqual({ cmem_line_anchors_v1: [anchor] });
    expect(JSON.parse(withLineAnchors('{"cmem_media_v1":{"version":1,"attachments":[]}}', [anchor])!)).toEqual({
      cmem_media_v1: { version: 1, attachments: [] },
      cmem_line_anchors_v1: [anchor],
    });
  });

  it('leaves metadata alone without anchors, and never overwrites a value that is not a JSON object', () => {
    expect(withLineAnchors('{"source":"import"}', [])).toBe('{"source":"import"}');
    expect(withLineAnchors(null, [])).toBeNull();
    expect(withLineAnchors('not json', [anchor])).toBe('not json');
  });

  it('reads anchors back, dropping malformed entries and keeping at most the per-observation cap', () => {
    const metadata = JSON.stringify({
      cmem_line_anchors_v1: [anchor, { path: 'b.ts', line: 0, text: 'y' }, { path: 'c.ts', line: 1, text: '   ' }, 'nonsense', anchor, anchor, anchor],
    });
    expect(readLineAnchors(metadata)).toEqual([anchor, anchor, anchor]);
    expect(readLineAnchors(JSON.stringify({ anchors: [anchor] }))).toEqual([]);
    expect(readLineAnchors('not json')).toEqual([]);
    expect(readLineAnchors(null)).toEqual([]);
  });
});

describe('findLineAnchor: never a guess', () => {
  const anchor: LineAnchor = { path: 'charge.ts', line: 3, text: 'export const MAX_CHARGE_RETRIES = 3;' };
  const find = (text: string) => findLineAnchor(anchor, indexFileLines(text));

  it('finds the line where it is now after lines were added above it, LF or CRLF', () => {
    expect(find(`// header\n// more\n${CHARGE}`)).toBe(5);
    expect(find(CHARGE.replace(/\n/g, '\r\n'))).toBe(3);
  });

  it('finds a re-indented line by its whitespace-squashed text', () => {
    expect(find(CHARGE.replace('export const MAX_CHARGE_RETRIES = 3;', '    export  const MAX_CHARGE_RETRIES =\t3;'))).toBe(3);
  });

  it('reports the line gone when its text changed', () => {
    expect(find(CHARGE.replace('= 3;', '= 4;'))).toBeNull();
  });

  it('reports the line gone when its text now occurs twice, never picking a copy', () => {
    expect(find(`${CHARGE}\nexport const MAX_CHARGE_RETRIES = 3;\n`)).toBeNull();
    // Two re-indented copies: the squashed text matches both.
    expect(find(CHARGE.replace('export const MAX_CHARGE_RETRIES = 3;', '  export const MAX_CHARGE_RETRIES = 3;\n\texport const MAX_CHARGE_RETRIES = 3;'))).toBeNull();
  });

  it('survives unrelated edits, as across commits, and drops only when its own line changes', () => {
    let text = CHARGE;
    const edits = [
      (t: string) => `import { log } from './log';\n${t}`,
      (t: string) => t.replace('  if (!card.token) {', '  if (!card || !card.token) {'),
      (t: string) => t.replace('export function chargeCard', '\nexport function chargeCard'),
      (t: string) => t.replace('export const MAX_CHARGE_RETRIES = 3;', 'export const MAX_CHARGE_RETRIES = 3; // tuned'),
    ];
    const found = edits.map(change => {
      text = change(text);
      return find(text);
    });
    expect(found).toEqual([4, 4, 4, null]);
  });
});

describe('lineAnchorStateOf and normalizeLineAnchorPath', () => {
  it('names the state of an observation\'s anchors on one file', () => {
    expect(lineAnchorStateOf({ lines: [12, 40], missing: 0 })).toBe('found');
    expect(lineAnchorStateOf({ lines: [12], missing: 1 })).toBe('partly-changed');
    expect(lineAnchorStateOf({ lines: [], missing: 2 })).toBe('changed');
  });

  it('compares paths with forward slashes and without a leading ./', () => {
    expect(normalizeLineAnchorPath('src\\shipping\\rates.ts')).toBe('src/shipping/rates.ts');
    expect(normalizeLineAnchorPath('./src/rates.ts')).toBe('src/rates.ts');
    expect(normalizeLineAnchorPath('.\\src\\rates.ts')).toBe('src/rates.ts');
    expect(normalizeLineAnchorPath('C:\\repo\\src\\rates.ts')).toBe('C:/repo/src/rates.ts');
  });
});
