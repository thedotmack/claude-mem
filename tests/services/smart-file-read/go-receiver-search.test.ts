import { afterAll, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeTest as test } from './native-prerequisite.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const root=mkdtempSync(join(tmpdir(),'cm-go-method-search-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
writeFileSync(join(root,'store.go'),`package owned
type Store struct {}
${Array.from({length:25},(_,i)=>`func (s Store) Method${i}() {}`).join('\n')}
func StoreCreate() {}
func StoreLoad() {}
func StoreUpdate() {}
func StoreRemove() {}`);
test('does not crowd a capped type search with receiver-owned methods', async()=>{
  const result=await searchCodebase(root,'Store',{maxResults:5});
  expect(result.matchingSymbols.map(s=>s.symbolName)).toEqual(['Store','StoreCreate','StoreLoad','StoreUpdate','StoreRemove']);
},120000);
test('keeps explicitly qualified method search available',async()=>{
  const result=await searchCodebase(root,'Store.Method7',{maxResults:5});
  expect(result.matchingSymbols.some(s=>s.symbolName==='Store.Method7')).toBe(true);
},120000);
