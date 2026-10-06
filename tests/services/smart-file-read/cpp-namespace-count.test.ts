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
  // Namespaces are scopes: they count, but only their members are results.
  expect(result.matchingSymbols.map(s=>s.symbolName)).toEqual(['A.B.f']);
  expect(result.totalSymbolsFound).toBe(3);
},120000);

const sharedRoot=mkdtempSync(join(tmpdir(),'cm-namespace-scope-'));
afterAll(()=>rmSync(sharedRoot,{recursive:true,force:true}));
writeFileSync(join(sharedRoot,'run.cpp'),'#include <memory>\n\nnamespace tensorflow {\nvoid Run() {}\n}\n');
writeFileSync(join(sharedRoot,'stop.cpp'),'#include <memory>\n\nnamespace tensorflow {\nvoid Stop() {}\n}\n');
test('a namespace repeated across files never fills results by its name, signature or includes',async()=>{
  for(const query of ['tensor','name','memory']){
    const result=await searchCodebase(sharedRoot,query);
    expect(result.matchingSymbols.filter(s=>s.kind==='namespace')).toEqual([]);
  }
  const qualified=await searchCodebase(sharedRoot,'tensorflow.Run');
  expect(qualified.matchingSymbols.map(s=>s.symbolName)).toEqual(['tensorflow.Run']);
  expect(qualified.totalSymbolsFound).toBe(4);
},120000);
