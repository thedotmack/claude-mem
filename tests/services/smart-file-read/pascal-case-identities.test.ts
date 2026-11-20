import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';

describe('Pascal routine identity ignores identifier case', () => {
  for (const header of [
    'procedure tCOUNTER.Reset;',
    'procedure TCounter.rESET;',
    'PROCEDURE TCounter.Reset;',
    'PrOcEdUrE tCOUNTER.rESET;',
  ]) {
    test(`attaches the implementation for ${header}`, () => {
      const source = `unit Counter;
interface
type
  TCounter = class
    procedure Reset;
  end;
implementation
${header}
begin
  WriteLn('Reset Body');
end;
end.`;
      const parsed = parseFile(source, 'Counter.pas');
      expect(parsed.symbols.map(symbol => symbol.name)).toEqual(['TCounter']);
      const members = parsed.symbols[0].children ?? [];
      expect(members.map(symbol => [symbol.name, symbol.kind, symbol.lineStart, symbol.lineEnd]))
        .toEqual([['Reset', 'method', 7, 10]]);
      expect(members[0].signature).toBe(header.replace(/tCounter\./i, ''));
      expect(unfoldSymbol(source, 'Counter.pas', 'TCounter.Reset')).toContain("WriteLn('Reset Body');");
    }, 120000);
  }

  test('merges standalone declarations with case-varied parameter and type names', () => {
    const source = `unit Standalone;
interface
procedure Ping(Value: Integer);
implementation
PROCEDURE pING(vALUE: iNTEGER);
begin
  WriteLn(vALUE);
end;
end.`;
    const roots = parseFile(source, 'Standalone.pas').symbols;
    expect(roots.map(symbol => [symbol.name, symbol.kind, symbol.lineStart, symbol.lineEnd]))
      .toEqual([['pING', 'function', 4, 7]]);
    expect(roots[0].signature).toBe('PROCEDURE pING(vALUE: iNTEGER);');
    expect(unfoldSymbol(source, 'Standalone.pas', 'pING')).toContain('WriteLn(vALUE);');
  }, 120000);

  test('preserves distinct overload types while matching their case-varied headers', () => {
    const source = `unit Overloads;
interface
type
  TThing = class
    procedure Run(A: Integer); overload;
    procedure Run(A: String); overload;
  end;
implementation
procedure tTHING.rUN(a: iNTEGER);
begin
  WriteLn(a + 1);
end;
PROCEDURE TTHING.RUN(A: STRING);
begin
  WriteLn(A + '!');
end;
end.`;
    const roots = parseFile(source, 'Overloads.pas').symbols;
    expect(roots.map(symbol => symbol.name)).toEqual(['TThing']);
    expect((roots[0].children ?? []).map(symbol => [symbol.name, symbol.lineStart, symbol.lineEnd]))
      .toEqual([['Run', 8, 11], ['Run', 12, 15]]);
  }, 120000);

  test('attaches advanced-record methods without changing their displayed names', () => {
    const source = `unit Records;
interface
type
  TRecord = record
    procedure Reset;
  end;
implementation
PROCEDURE trecord.reset;
begin
  WriteLn('Record Body');
end;
end.`;
    const roots = parseFile(source, 'Records.pas').symbols;
    expect(roots.map(symbol => symbol.name)).toEqual(['TRecord']);
    expect((roots[0].children ?? []).map(symbol => symbol.name)).toEqual(['Reset']);
    expect(unfoldSymbol(source, 'Records.pas', 'TRecord.Reset')).toContain("WriteLn('Record Body');");
  }, 120000);
});
