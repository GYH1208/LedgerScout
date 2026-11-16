import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,mkdir,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session.js';
test('legacy sessions gain Ethereum domain and cannot open equity session files',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'domain-session-'));
  try{
    await mkdir(join(dir,'s_legacy'));await writeFile(join(dir,'s_legacy','session.json'),JSON.stringify({version:1,sessionId:'s_legacy',addresses:[],turns:[],queries:[]}));
    const legacy=new SessionStore(dir,'s_legacy',[]);await legacy.open();assert.equal((legacy.data as any).researchDomain,'ethereum');
    await mkdir(join(dir,'s_equity'));await writeFile(join(dir,'s_equity','session.json'),JSON.stringify({version:1,sessionId:'s_equity',researchDomain:'us-equity',addresses:[],turns:[],queries:[]}));
    await assert.rejects(new SessionStore(dir,'s_equity',[]).open(),/domain/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});
