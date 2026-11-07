import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
const source=`namespace Local {
  void reset() { local_body(); }
}
namespace Remote {
  namespace Inner {
    void reset() { remote_body(); }
  }
}`;
describe('C++ namespace symbol ownership',()=>{
  test('retains named and nested namespaces without turning free functions into methods',()=>{
    const symbols=parseFile(source,'stores.cpp').symbols;
    expect(symbols.map(symbol=>[symbol.name,symbol.kind])).toEqual([['Local','namespace'],['Remote','namespace']]);
    expect(symbols[0].children?.map(child=>[child.name,child.kind])).toEqual([['reset','function']]);
    expect(symbols[1].children?.[0].name).toBe('Inner');
  },120000);
  test('unfolds identical free function names through their namespace chains',()=>{
    const local=unfoldSymbol(source,'stores.cpp','Local.reset');
    const remote=unfoldSymbol(source,'stores.cpp','Remote.Inner.reset');
    expect(local).toContain('local_body');expect(local).not.toContain('remote_body');
    expect(remote).toContain('remote_body');expect(remote).not.toContain('local_body');
  },120000);
});
