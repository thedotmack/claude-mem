import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWatchState } from '../../src/services/transcripts/state.js';
const root=mkdtempSync(join(tmpdir(),'cm-checkpoint-shapes-'));
const path=join(root,'state.json');
afterAll(()=>rmSync(root,{recursive:true,force:true}));
describe('transcript checkpoint recovery',()=>{
  it('drops invalid offsets while retaining usable progress',()=>{
    writeFileSync(path,JSON.stringify({offsets:{good:42,zero:0,string:'8',negative:-1,fraction:1.5,unsafe:Number.MAX_SAFE_INTEGER+1},
      partials:{good:'partial',wrong:3},frameLines:{good:2,wrong:-1},cwds:{good:'/owned',wrong:{}}}));
    expect(loadWatchState(path)).toEqual({offsets:{good:42,zero:0},partials:{good:'partial'},frameLines:{good:2},cwds:{good:'/owned'}});
  });
  for(const offsets of ['wrong', [4,5], 7]) it(`recovers a malformed offset map ${JSON.stringify(offsets)}`,()=>{
    writeFileSync(path,JSON.stringify({offsets}));
    expect(loadWatchState(path)).toEqual({offsets:{}});
  });
});
