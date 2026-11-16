import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp,rm,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from '../src/server.js';
import { cfg,headers,offlineRun } from './support.js';
import { WebStore } from '../src/storage.js';

test('local HTTP equity endpoints honor origin checks and report domain configuration independently',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'equity-routes-'));
  const server=createWebServer({config:()=>cfg(dir),run:offlineRun(),equity:{config:()=>({fmpKey:'',secUserAgent:'',timeoutMs:1000,maxRetries:0,dailyLimit:200,outputDirectory:dir})}});
  server.listen(0,'127.0.0.1');await once(server,'listening');await server.ready;
  try{
    const base=`http://127.0.0.1:${(server.address() as any).port}`;
    const state=await fetch(base+'/api/equity/state');assert.equal(state.status,200);const body=await state.json() as any;
    assert.equal(body.configured.deepseek,true);assert.equal(body.configured.fmp,false);assert.equal(body.market,null);
    const forbidden=await fetch(base+'/api/equity/pool',{method:'POST',headers:{...headers,origin:'https://untrusted.invalid'},body:JSON.stringify({symbols:['AAPL']})});assert.equal(forbidden.status,403);
    const accepted=await fetch(base+'/api/equity/pool',{method:'POST',headers,body:JSON.stringify({symbols:['AAPL']})});assert.equal(accepted.status,200);
    const missing=await fetch(base+'/api/equity/refresh',{method:'POST',headers,body:JSON.stringify({kind:'market'})});assert.equal(missing.status,503);
    assert.equal(JSON.stringify(await missing.json()).includes('offline-model-secret'),false);
    const discovery=await fetch(base+'/api/equity/discovery/state');assert.equal(discovery.status,200);const ds=await discovery.json() as any;assert.equal(ds.coverage.prepared,false);
    const members=Array.from({length:30},(_,i)=>({symbol:'A'+i,name:'长'.repeat(200),themes:['workflow'],sources:[]}));
    const bodyText=JSON.stringify({expectedVersion:ds.universe.version,members});assert.ok(Buffer.byteLength(bodyText)>16384);
    const catalog=await fetch(base+'/api/equity/discovery/universe',{method:'POST',headers,body:bodyText});assert.equal(catalog.status,200);
    const forbiddenDiscovery=await fetch(base+'/api/equity/discovery/universe',{method:'POST',headers:{...headers,origin:'https://untrusted.invalid'},body:bodyText});assert.equal(forbiddenDiscovery.status,403);
    const chain=await fetch(base+'/api/state');assert.equal(chain.status,200);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await server.shutdown;await rm(dir,{recursive:true,force:true});}
});

test('legacy Web session migration backs up SQLite and exposes fixed Ethereum domain',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'domain-migration-'));let store:WebStore|undefined;
  try{
    store=new WebStore(join(dir,'web.sqlite'));const accepted=store.accept({title:'旧研究',question:'余额',date:'2026-11-15'});
    assert.equal((store.list().sessions[0] as any).researchDomain,'ethereum');
    store.close();store=undefined;
    const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(dir,'web.sqlite'));
    db.exec('ALTER TABLE sessions DROP COLUMN research_domain; PRAGMA user_version=2');db.close();
    store=new WebStore(join(dir,'web.sqlite'));
    assert.equal((store.list().sessions[0] as any).researchDomain,'ethereum');
    assert.equal(store.hasSession(accepted.sessionId),true);
    assert.ok((await readdir(dir)).some(name=>name.startsWith('web-before-v3-')));
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
