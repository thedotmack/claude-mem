import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const thisTestFile = fileURLToPath(import.meta.url);
const __dirname = path.dirname(thisTestFile);
const projectRoot = path.resolve(__dirname, '../..');

// TypeScript 7 runs the typechecks, and its npm package no longer exports the
// JavaScript compiler API (createSourceFile, ScriptTarget, ...). Code that parses
// TypeScript imports the TypeScript 6 API through the `typescript-compiler-api`
// alias in package.json instead (#6188). A plain import of the `typescript`
// package still resolves, but every AST call on it throws at runtime.
const SCANNED_DIRECTORIES = ['scripts', 'src', 'tests'];
const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', 'dist', 'build']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const TYPESCRIPT_PACKAGE_IMPORT = /\bfrom\s+['"]typescript['"]|\b(?:require|import)\(\s*['"]typescript['"]\s*\)/;

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORY_NAMES.has(entry.name)) files.push(...listSourceFiles(path.join(directory, entry.name)));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

describe('TypeScript compiler API imports', () => {
  it('go through the typescript-compiler-api alias, not the typescript package', () => {
    const offenders = SCANNED_DIRECTORIES
      .flatMap(directory => listSourceFiles(path.join(projectRoot, directory)))
      // This file's own self-test below spells out the forbidden imports.
      .filter(file => file !== thisTestFile)
      .filter(file => TYPESCRIPT_PACKAGE_IMPORT.test(readFileSync(file, 'utf-8')))
      .map(file => path.relative(projectRoot, file));

    expect(
      offenders,
      `Import the compiler API from 'typescript-compiler-api' in: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  it('recognises every import form it guards against', () => {
    for (const line of [
      "import ts from 'typescript';",
      'import * as ts from "typescript";',
      "const ts = require('typescript');",
      "const ts = await import('typescript');",
    ]) {
      expect(TYPESCRIPT_PACKAGE_IMPORT.test(line), line).toBe(true);
    }
    for (const line of [
      "import ts from 'typescript-compiler-api';",
      "import TypeScript from 'tree-sitter-typescript';",
      "const language = 'typescript';",
    ]) {
      expect(TYPESCRIPT_PACKAGE_IMPORT.test(line), line).toBe(false);
    }
  });
});
