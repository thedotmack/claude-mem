import { describe, it, expect, beforeEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../../../src/shared/paths.js';
import { parseFile, resolveTreeSitterBinPath, _resetGrammarLibOptOut } from '../../../src/services/smart-file-read/parser.js';

// Grammar compile reuse (#3926): `tree-sitter query -p <grammar-dir>` implies
// --rebuild, so the CLI recompiled the grammar from C on every smart_outline /
// smart_search / smart_unfold call — a fixed ~700ms tax per language per call,
// paid before a single node could be matched. The parser now builds each grammar
// once into <data-dir>/tree-sitter-libs and queries with `-l <lib> --lang-name`.
//
// tests/preload.ts pins CLAUDE_MEM_DATA_DIR to a per-run temp dir, so the
// artifacts asserted on here never land in a real ~/.claude-mem.
const LIB_DIR = join(resolveDataDir(), 'tree-sitter-libs');
const SOURCE = 'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n';

// The tree-sitter binary is a runtime prerequisite, not a build one: installs
// that ran with --ignore-scripts have no binary and fall back to a symbol-less
// folded view. Asserting parse output there would fail for reasons this change
// does not own.
function treeSitterAvailable(): boolean {
  try {
    execFileSync(resolveTreeSitterBinPath(), ['--version'], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function typescriptLib(): string {
  const entry = readdirSync(LIB_DIR).find((file) => file.startsWith('typescript.'));
  if (!entry) throw new Error(`no compiled typescript grammar in ${LIB_DIR}`);
  return join(LIB_DIR, entry);
}

// The initial `tree-sitter build` compiles C grammar sources from scratch in a
// fresh temp data dir (pinned by tests/preload.ts). On CI runners this can take
// 10-30 s, so each test carries a generous per-test timeout. The first test
// naturally warms the compiled artifact; the second benefits from the cache.
describe.if(treeSitterAvailable())('compiled grammar reuse', () => {
  beforeEach(() => {
    _resetGrammarLibOptOut();
  });

  it('parses through a compiled artifact and does not rebuild it on the next call', () => {
    expect(parseFile(SOURCE, 'greeter.ts').symbols.map((s) => s.name)).toContain('greet');

    const libPath = typescriptLib();
    const builtAt = statSync(libPath).mtimeMs;

    expect(parseFile(SOURCE, 'greeter.ts').symbols.map((s) => s.name)).toContain('greet');
    expect(statSync(libPath).mtimeMs).toBe(builtAt);
  }, 120_000);

  it('rebuilds an artifact older than the grammar sources', () => {
    expect(parseFile(SOURCE, 'greeter.ts').symbols.map((s) => s.name)).toContain('greet');

    // A plugin update ships new grammar packages; an artifact left over from the
    // previous version would otherwise keep parsing with the old grammar. The
    // epoch is used rather than a relative offset so the assertion does not
    // depend on how long ago node_modules was installed — npm and bun both stamp
    // grammar sources with the install time, which can be days old.
    const libPath = typescriptLib();
    utimesSync(libPath, new Date(0), new Date(0));

    expect(parseFile(SOURCE, 'greeter.ts').symbols.map((s) => s.name)).toContain('greet');
    expect(statSync(libPath).mtimeMs).toBeGreaterThan(0);
  }, 120_000);
});
