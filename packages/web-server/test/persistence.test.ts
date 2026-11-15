import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, rename, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebStore } from '../src/storage.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runAgent } from '@ledgerscout/agent-runtime';
import { recovery } from '../src/history.js';
import { cfg, done, offlineRun, post, question, start, state } from './support.js';

async function temp() {return mkdtemp(join(tmpdir(),'ledger-web-persist-'));}

test('actual Runtime survives API restart with exact evidence and a historical follow-up without new data HTTP',async()=>{
 const dir=await temp();let h=await start(dir);
 try{
  const accepted=await(await post(h.base,'/api/runs',{question})).json() as any;const first=(await done(h.base)).sessions[0].turns[0].run;assert.equal(first.status,'completed');
  await h.close();let fetched=0;h=await start(dir,offlineRun({onFetch:()=>fetched++}));
  const restored=(await state(h.base)).body.sessions[0];assert.equal(restored.id,accepted.sessionId);assert.equal(restored.turns[0].run.answer,first.answer);
  const qid=first.queries[0].queryId;const evidence=await(await fetch(h.base+`/api/evidence/${accepted.jobId}/${qid}`)).json() as any;assert.equal(evidence.query.balance.wei,'1000000000000000001');
  assert.equal((await fetch(h.base+`/api/evidence/j_unknown/${qid}`)).status,404);
  assert.equal((await post(h.base,'/api/runs',{sessionId:accepted.sessionId,question:`解释查询 ${qid} 的已有证据，不要刷新数据`})).status,202);
  const follow=(await done(h.base)).sessions[0].turns.at(-1).run;assert.equal(follow.status,'completed');assert.equal(follow.queries[0].queryId,qid);assert.equal(follow.counts.http,0);assert.equal(fetched,0);
  await h.close();h=await start(dir);assert.equal((await state(h.base)).body.sessions[0].turns.length,2);
 }finally{await h.close();await rm(dir,{recursive:true,force:true});}
});

test('startup reconciles an uncommitted SQL terminal from its durable Runtime result without replay',async()=>{
 const dir=await temp();const store=new WebStore(join(dir,'web.sqlite'));const job=store.accept({title:'balance',question,date:'2026-11-15'});
 const r=await offlineRun()({input:question,sessionId:job.sessionId,config:cfg(dir).chain,outputDirectory:dir,request:async()=>({content:''})});store.bindRun(job.jobId,r.runId);store.close();
 const h=await start(dir,async()=>{throw Error('must not replay');});
 try{const t=(await state(h.base)).body.sessions[0].turns[0];assert.equal(t.status,'completed');assert.equal(t.id,job.jobId);assert.equal(t.run.answer,r.answer);}
 finally{await h.close();await rm(dir,{recursive:true,force:true});}
});

test('accepted tasks without a checkpoint restart as interrupted and do not offer fake recovery',async()=>{
 const dir=await temp(),store=new WebStore(join(dir,'web.sqlite'));const job=store.accept({title:'accepted',question,date:'2026-11-15'});store.close();
 const h=await start(dir,async()=>{throw Error('must not run');});
 try{const t=(await state(h.base)).body.sessions[0].turns[0];assert.equal(t.status,'interrupted');assert.equal(t.run,undefined);assert.equal(t.recovery,undefined);assert.equal((await state(h.base)).body.busy,false);assert.equal(t.id,job.jobId);}
 finally{await h.close();await rm(dir,{recursive:true,force:true});}
});

test('historical import is idempotent and ignores malformed or non-session directories',async()=>{
 const dir=await temp();const r=await offlineRun()({input:question,sessionId:'s_legacy',config:cfg(dir).chain,outputDirectory:dir,request:async()=>({content:''})});
 const invalid=join(dir,'s_legacy','r_broken');const {mkdir}=await import('node:fs/promises');await mkdir(invalid);await writeFile(join(invalid,'run-summary.json'),'{bad json');
 let h=await start(dir);
 try{const s=(await state(h.base)).body;assert.equal(s.sessions.length,1);assert.equal(s.sessions[0].turns[0].question,question);assert.equal(s.sessions[0].turns[0].run.runId,r.runId);assert(s.importWarnings>0);await h.close();h=await start(dir);assert.equal((await state(h.base)).body.sessions[0].turns.length,1);}
 finally{await h.close();await rm(dir,{recursive:true,force:true});}
});

test('import database failure stays unready and retries valid history on next startup',async()=>{
 const dir=await temp();await offlineRun()({input:question,sessionId:'s_legacy',config:cfg(dir).chain,outputDirectory:dir,request:async()=>({content:''})});
 const store=new WebStore(join(dir,'web.sqlite'));store.close();const db=new DatabaseSync(join(dir,'web.sqlite'));db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'write failure'); END");db.close();
 let h=await start(dir);
 try{assert.equal((await state(h.base)).status,503);await h.close();const fixed=new DatabaseSync(join(dir,'web.sqlite'));fixed.exec('DROP TRIGGER reject_import');fixed.close();h=await start(dir);assert.equal((await state(h.base)).body.sessions[0].turns.length,1);}
 finally{await h.close();await rm(dir,{recursive:true,force:true});}
});

test('a second database owner is unready and cannot interrupt the active first instance',async()=>{
 const dir=await temp();let release:()=>void=()=>{};const gate=new Promise<void>(r=>release=r);const first=await start(dir,offlineRun({onModel:()=>gate}));let second:Awaited<ReturnType<typeof start>>|undefined;
 try{await post(first.base,'/api/runs',{question});second=await start(dir);assert.equal((await state(second.base)).status,503);const original=await state(first.base);assert.equal(original.body.busy,true);assert.equal(original.body.sessions[0].turns[0].status,'loading');}
 finally{release();await done(first.base);await second?.close();await first.close();await rm(dir,{recursive:true,force:true});}
});

test('failed durable acceptance rolls back before invoking Runtime',async()=>{
 const dir=await temp();let ran=0;const h=await start(dir,async()=>{ran++;throw Error('must not run');});
 try{const db=new DatabaseSync(join(dir,'web.sqlite'));db.exec("CREATE TRIGGER reject_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'disk unavailable'); END");db.close();assert.equal((await post(h.base,'/api/runs',{question})).status,500);assert.equal(ran,0);assert.equal((await state(h.base)).body.sessions.length,0);}
 finally{await h.close();await rm(dir,{recursive:true,force:true});}
});

test('missing or symlinked evidence is unavailable instead of reading unregistered files',async()=>{
 const dir=await temp(),h=await start(dir);
 try{const accepted=await(await post(h.base,'/api/runs',{question})).json() as any;const r=(await done(h.base)).sessions[0].turns[0].run;const q=r.queries[0].queryId;
  const file=join(dir,r.sessionId,r.runId,'queries',q,'query.json'),outside=join(dir,'unregistered.json');await rename(file,outside);await symlink(outside,file);
  const response=await fetch(h.base+`/api/evidence/${accepted.jobId}/${q}`);assert.equal(response.status,404);assert.equal((await response.text()).includes(dir),false);
 }finally{await h.close();await rm(dir,{recursive:true,force:true});}
});

test('failed resume before Runtime activation remains retryable; consumed checkpoints cannot resume twice',async()=>{
 const dir=await temp();let h=await start(dir,offlineRun({cancelAfterQuery:true}));
 try{
  const accepted=await(await post(h.base,'/api/runs',{question})).json() as any;const first=(await done(h.base)).sessions[0].turns[0].run;assert.equal(first.status,'cancelled');assert.equal(first.resumable,true);
  await h.close();h=await start(dir,async()=>{throw Error('failed before checkpoint activation');});
  assert.equal((await post(h.base,'/api/runs',{sessionId:accepted.sessionId,resumeRunId:first.runId})).status,202);const failed=await done(h.base);assert.equal(failed.sessions[0].turns[0].run.resumable,true);
  await h.close();h=await start(dir);assert.equal((await post(h.base,'/api/runs',{sessionId:accepted.sessionId,resumeRunId:first.runId})).status,202);
  const finished=await done(h.base),last=finished.sessions[0].turns.at(-1).run;assert.equal(last.status,'completed');assert.equal(last.counts.http,first.counts.http);assert.equal(finished.sessions[0].turns[0].run.resumable,false);
  assert.equal((await post(h.base,'/api/runs',{sessionId:accepted.sessionId,resumeRunId:first.runId})).status,409);
 }finally{await h.close();await rm(dir,{recursive:true,force:true});}
});

for(const mode of ['checkpoint','no-checkpoint'])test(`SIGKILL restart with ${mode} restores an interrupted task without provider replay`,async()=>{
 const dir=await temp();const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/crash-server.ts',import.meta.url)),dir,mode],{stdio:['ignore','pipe','pipe']});
 let output='';let resolvePause:()=>void=()=>{};const paused=new Promise<void>(r=>resolvePause=r);
 const port=new Promise<number>((resolve,reject)=>{child.stdout.on('data',chunk=>{output+=String(chunk);const match=output.match(/READY (\d+)/);if(match)resolve(Number(match[1]));if(output.includes('PAUSED'))resolvePause();});child.on('error',reject);child.on('exit',()=>reject(Error('Child exited before startup: '+output)));});
 let h:Awaited<ReturnType<typeof start>>|undefined;const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
 try{
  const base='http://127.0.0.1:'+await port;await post(base,'/api/runs',{question}).catch(()=>{});await paused;
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;clearTimeout(timer);
  let fetched=0;h=await start(dir,offlineRun({onFetch:()=>fetched++}));const s=(await state(h.base)).body,t=s.sessions[0].turns[0];
  assert.equal(t.status,'interrupted');assert.equal(t.run,undefined);assert.equal(s.busy,false);assert.equal(fetched,0);
  assert.equal(Boolean(t.recovery),mode==='checkpoint');
  if(t.recovery){assert.equal((await post(h.base,'/api/runs',{sessionId:t.recovery.sessionId,resumeRunId:t.recovery.runId})).status,202);const last=(await done(h.base)).sessions[0].turns.at(-1).run;assert.equal(last.status,'completed');assert.equal(last.counts.http,3);assert.equal(fetched,0);}
 }finally{clearTimeout(timer);child.kill('SIGKILL');await h?.close();await rm(dir,{recursive:true,force:true});}
});

test('a completed Runtime result is reconciled after final SQL persistence failed',async()=>{
 const dir=await temp();let h=await start(dir);
 try{
  const db=new DatabaseSync(join(dir,'web.sqlite'));db.exec("CREATE TRIGGER reject_final BEFORE UPDATE OF result_json ON jobs BEGIN SELECT RAISE(ABORT,'write failure'); END");
  const accepted=await(await post(h.base,'/api/runs',{question})).json() as any;const failed=await done(h.base);assert.equal(failed.sessions[0].turns[0].status,'failed');assert.equal(failed.sessions[0].turns[0].run,undefined);
  db.exec('DROP TRIGGER reject_final');db.close();await h.close();h=await start(dir);
  const restored=(await state(h.base)).body.sessions[0].turns[0];assert.equal(restored.run?.status,'completed');assert.match(restored.run.answer,/1\.000000000000000001/);
  assert.equal((await fetch(h.base+`/api/evidence/${accepted.jobId}/${restored.run.queries[0].queryId}`)).status,200);
 }finally{await h.close();await rm(dir,{recursive:true,force:true});}
});

test('a failed bound job without a result still exposes its valid checkpoint',async()=>{
 const dir=await temp(),h=await start(dir,offlineRun({cancelAfterQuery:true}));
 try{
  await post(h.base,'/api/runs',{question});const t=(await done(h.base)).sessions[0].turns[0];assert.equal(t.run.resumable,true);
  await unlink(join(dir,t.run.sessionId,t.run.runId,'run-summary.json'));
  const db=new DatabaseSync(join(dir,'web.sqlite'));db.prepare("UPDATE jobs SET status='failed',result_json=NULL WHERE id=?").run(t.id);db.close();
  const current=(await state(h.base)).body.sessions[0].turns[0];assert.equal(current.recovery?.runId,t.run.runId);
 }finally{await h.close();await rm(dir,{recursive:true,force:true});}
});

for(const malformed of ['duplicate queries','oversized projection'])test(`import skips ${malformed} without disabling other local history`,async()=>{
 const dir=await temp();let h:Awaited<ReturnType<typeof start>>|undefined;
 try{
  const r=await offlineRun()({input:question,sessionId:'s_legacy',config:cfg(dir).chain,outputDirectory:dir,request:async()=>({content:''})});
  if(malformed==='duplicate queries')r.queries.push(r.queries[0]!);else r.answer='x'.repeat(2_000_001);
  await writeFile(join(dir,r.sessionId,r.runId,'run-summary.json'),JSON.stringify(r));h=await start(dir);const s=await state(h.base);assert.equal(s.status,200);assert.equal(s.body.sessions.length,0);assert.equal(s.body.importWarnings,1);
 }finally{await h?.close();await rm(dir,{recursive:true,force:true});}
});

for(const dependency of ['ENS proof','terminal summary','parent checkpoint'])test(`recovery rejects a symlinked ${dependency} outside its output root`,async()=>{
 const dir=await temp(),external=await temp();let r;let path:string;
 try{
  if(dependency==='ENS proof'){
   const ctl=new AbortController(),word=(n:number)=>n.toString(16).padStart(64,'0');
   r=await runAgent({input:'查询 vitalik.eth 当前 ETH 余额',config:cfg(dir).chain,outputDirectory:dir,signal:ctl.signal,request:async()=>({content:''}),onEvent:e=>{if(e.type==='ens_resolved')ctl.abort();},fetch:async(_u,init)=>{
    const b=JSON.parse(String(init?.body));return Response.json({jsonrpc:'2.0',id:b.id,result:b.method==='eth_chainId'?'0x1':b.method==='eth_blockNumber'?'0xa':'0x'+word(64)+'3'.repeat(40).padStart(64,'0')+word(32)+'1'.repeat(40).padStart(64,'0')});
   }});
   path=join(dir,r.sessionId,r.runId,'resolutions',r.ensResolutions![0]!.resolutionId,'resolution.json');
  }else{
   r=await offlineRun({cancelAfterQuery:true})({input:question,sessionId:'s_guard',config:cfg(dir).chain,outputDirectory:dir,request:async()=>({content:''})});
   path=join(dir,r.sessionId,r.runId,dependency==='terminal summary'?'run-summary.json':'checkpoint.json');
   if(dependency==='parent checkpoint'){
    const ctl=new AbortController();r=await runAgent({input:'',sessionId:r.sessionId,resumeRunId:r.runId,config:cfg(dir).chain,outputDirectory:dir,signal:ctl.signal,request:async()=>{ctl.abort();return new Promise(()=>{});}});
   }
  }
  assert.equal(r.status,'cancelled');const job={id:'j_guard',sessionId:r.sessionId,runId:r.runId,question,status:'cancelled',progress:[]};assert(await recovery(dir,job));
  const outside=join(external,'proof.json');await rename(path,outside);await symlink(outside,path);assert.equal(await recovery(dir,job),undefined);
 }finally{await rm(dir,{recursive:true,force:true});await rm(external,{recursive:true,force:true});}
});
