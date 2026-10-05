import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
const source=`class App::Cache
  def reset
    cache_body
  end
end
module App::Helpers
  def self.find
    helpers_body
  end
end`;
describe('Ruby qualified container declarations',()=>{
  test('retains scoped class and module owners',()=>{
    const symbols=parseFile(source,'cache.rb').symbols;
    expect(symbols.map(symbol=>symbol.name)).toEqual(['App::Cache','App::Helpers']);
    expect(symbols.map(symbol=>symbol.children?.map(child=>child.name))).toEqual([['reset'],['self.find']]);
  },120000);
  test('unfolds qualified instance and singleton identities',()=>{
    expect(unfoldSymbol(source,'cache.rb','App::Cache#reset')).toContain('cache_body');
    expect(unfoldSymbol(source,'cache.rb','App::Helpers.find')).toContain('helpers_body');
  },120000);
});
