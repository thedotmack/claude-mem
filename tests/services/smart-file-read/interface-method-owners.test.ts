import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, unfoldSymbol, formatAvailableSymbols } from '../../../src/services/smart-file-read/parser.js';
const source=`interface Local {
  void reset();
}
interface Remote {
  void reset();
}`;
describe('interface method ownership',()=>{
  test('keeps interface methods inside their declared interface',()=>{
    const symbols=parseFile(source,'Stores.java').symbols;
    expect(symbols.map(symbol=>symbol.name)).toEqual(['Local','Remote']);
    expect(symbols.map(symbol=>symbol.children?.map(child=>child.name))).toEqual([['reset'],['reset']]);
  },120000);
  test('unfolds a method by its interface owner',()=>{
    const local=unfoldSymbol(source,'Stores.java','Local.reset');
    const remote=unfoldSymbol(source,'Stores.java','Remote.reset');
    expect(local).toContain('void reset();');expect(local).toContain('L2-2');
    expect(remote).toContain('void reset();');expect(remote).toContain('L5-5');
  },120000);
});

 test('offers qualified child methods in a failed lookup hint',()=>{
  const hint=formatAvailableSymbols(parseFile(source,'Stores.java'));
  expect(hint).toContain('Local.reset (method)');
  expect(hint).toContain('Remote.reset (method)');
 },120000);
