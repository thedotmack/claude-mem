import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatFoldedView, parseFile, unfoldSymbol, _isGrammarLibOptedOut, _resetGrammarLibOptOut } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const SOURCE = `unit Counter;
interface
type
  TCounter = class
  private
    FValue: Integer;
  public
    procedure Reset;
    function Value: Integer;
    property Total: Integer read FValue;
  end;
implementation
procedure TCounter.Reset;
begin
  FValue := 0;
end;
function TCounter.Value: Integer;
begin
  Result := FValue;
end;
end.`;

describe('Delphi/Pascal outlines', () => {
  test('nests class members and attaches implementation bodies to them', () => {
    const parsed = parseFile(SOURCE, 'Counter.pas');
    expect(parsed.language).toBe('pascal');
    expect(parsed.symbols.map(symbol => symbol.name)).toEqual(['TCounter']);

    const members = parsed.symbols[0].children ?? [];
    expect(members.map(symbol => [symbol.name, symbol.kind])).toEqual([
      ['Reset', 'method'],
      ['Value', 'method'],
      ['Total', 'property'],
    ]);

    const reset = members.find(symbol => symbol.name === 'Reset');
    expect(reset?.lineStart).toBe(12);
    expect(reset?.lineEnd).toBe(15);

    const value = members.find(symbol => symbol.name === 'Value');
    expect(value?.lineStart).toBe(16);
    expect(value?.lineEnd).toBe(19);

    const view = formatFoldedView(parsed);
    expect(view).toContain('TCounter');
    expect(view).toContain('Reset');
    expect(view).toContain('property Total');
  }, 120000);

  test('unfolds the implementation rather than the class declaration', () => {
    const reset = unfoldSymbol(SOURCE, 'Counter.pas', 'TCounter.Reset');
    expect(reset).toContain('FValue := 0;');
    expect(reset).not.toContain('Result := FValue;');
  }, 120000);

  test('keeps overloaded methods separate and gives each its own body', () => {
    const source = `unit Overloads;
interface
type
  TThing = class
    procedure Run;
    procedure Run(Step: Integer);
  end;
implementation
procedure TThing.Run;
begin
  Run(1);
end;
procedure TThing.Run(Step: Integer);
begin
  WriteLn(Step);
end;
end.`;
    const members = parseFile(source, 'Overloads.pas').symbols[0].children ?? [];
    expect(members.map(symbol => [symbol.name, symbol.lineStart, symbol.lineEnd])).toEqual([
      ['Run', 8, 11],
      ['Run', 12, 15],
    ]);
  }, 120000);

  test('merges a standalone interface declaration with its implementation', () => {
    const source = `unit Standalone;
interface
procedure Ping(A: Integer);
implementation
procedure Ping(A: Integer);
begin
  WriteLn(A);
end;
end.`;
    const roots = parseFile(source, 'Standalone.pas').symbols;
    expect(roots.map(symbol => [symbol.name, symbol.kind, symbol.lineStart, symbol.lineEnd]))
      .toEqual([['Ping', 'function', 4, 7]]);
  }, 120000);

  test('keeps overloads that differ only in a later parameter group apart', () => {
    const source = `unit LaterParams;
interface
type
  TThing = class
    procedure Run(A: Integer; B: Integer); overload;
    procedure Run(A: Integer; B: String); overload;
  end;
procedure Walk(A: Integer; B: Integer); overload;
procedure Walk(A: Integer; B: String); overload;
implementation
procedure TThing.Run(A: Integer; B: Integer);
begin
  WriteLn(B + 1);
end;
procedure TThing.Run(A: Integer; B: String);
begin
  WriteLn(B);
end;
procedure Walk(A: Integer; B: Integer);
begin
  WriteLn(B + 2);
end;
procedure Walk(A: Integer; B: String);
begin
  WriteLn(B + '!');
end;
end.`;
    const roots = parseFile(source, 'LaterParams.pas').symbols;
    const members = roots.find(symbol => symbol.name === 'TThing')?.children ?? [];
    expect(members.map(symbol => [symbol.name, symbol.lineStart, symbol.lineEnd])).toEqual([
      ['Run', 10, 13],
      ['Run', 14, 17],
    ]);
    const walks = roots.filter(symbol => symbol.name === 'Walk');
    expect(walks.map(symbol => [symbol.kind, symbol.lineStart, symbol.lineEnd])).toEqual([
      ['function', 18, 21],
      ['function', 22, 25],
    ]);
  }, 120000);

  test('attaches advanced-record method bodies to the record member', () => {
    const source = `unit Records;
interface
type
  TRec = record
    Count: Integer;
    procedure Reset;
  end;
implementation
procedure TRec.Reset;
begin
  Count := 0;
end;
end.`;
    const roots = parseFile(source, 'R.pas').symbols;
    expect(roots.map(symbol => symbol.name)).toEqual(['TRec']);
    const reset = unfoldSymbol(source, 'R.pas', 'TRec.Reset');
    expect(reset).toContain('Count := 0;');
  }, 120000);

  test('queries through the compiled grammar library, not a per-call rebuild', () => {
    // The grammar exports tree_sitter_delphi, so `--lang-name pascal` would not
    // bind and every Pascal call would recompile the 6 MB parser.c (#3926).
    _resetGrammarLibOptOut();
    expect(parseFile(SOURCE, 'Counter.pas').symbols.map(symbol => symbol.name)).toEqual(['TCounter']);
    expect(_isGrammarLibOptedOut('pascal')).toBe(false);
  }, 120000);

  test('native batched search finds a class method by qualified name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-pascal-outline-'));
    try {
      writeFileSync(join(dir, 'Counter.pas'), SOURCE);
      const result = await searchCodebase(dir, 'Reset');
      expect(result.matchingSymbols.find(symbol => symbol.symbolName === 'TCounter.Reset')?.kind).toBe('method');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
