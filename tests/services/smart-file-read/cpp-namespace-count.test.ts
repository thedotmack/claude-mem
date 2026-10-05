import { afterAll, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeTest as test } from './native-prerequisite.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const root=mkdtempSync(join(tmpdir(),'cm-namespace-count-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
writeFileSync(join(root,'nested.cpp'),'namespace A { namespace B { void f() {} } }');
test('counts every native nested namespace descendant in search totals',async()=>{
  const result=await searchCodebase(root,'',{maxResults:20});
  expect(result.matchingSymbols.map(s=>s.symbolName)).toEqual(['A','A.B','A.B.f']);
  expect(result.totalSymbolsFound).toBe(3);
},120000);
