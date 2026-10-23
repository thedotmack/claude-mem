import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatFoldedView, parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
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
