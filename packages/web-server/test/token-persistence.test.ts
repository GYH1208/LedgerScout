import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cfg, contract, done, offlineRun, post, start, state, tokenQuestion } from './support.js';

for (const metadataError of [false, true]) test(`ERC20 evidence survives SQLite restart with ${metadataError?'unknown':'exact'} decimals`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ledger-web-token-'));
  let fetched=0,h=await start(dir,offlineRun({token:true,metadataError,onFetch:()=>fetched++}));
  try{
    const accepted=await(await post(h.base,'/api/runs',{question:tokenQuestion})).json() as any;
    const first=(await done(h.base)).sessions[0].turns[0].run;
    assert.equal(first.status,metadataError?'partial':'completed');
    assert.equal(first.queries[0].contractAddress,contract);
    assert.deepEqual(first.queries[0].tokenBalance,{rawBalance:'9007199254740993',decimals:metadataError?null:6,amount:metadataError?null:'9007199254.740993'});
    await h.close();fetched=0;h=await start(dir,offlineRun({token:true,onFetch:()=>fetched++}));
    assert.equal((await state(h.base)).body.sessions[0].turns[0].run.answer,first.answer);
    const qid=first.queries[0].queryId;
    const evidence=await fetch(h.base+`/api/evidence/${accepted.jobId}/${qid}`);assert.equal(evidence.status,200);
    assert.deepEqual((await evidence.json() as any).query.tokenBalance,first.queries[0].tokenBalance);
    assert.equal((await post(h.base,'/api/runs',{sessionId:accepted.sessionId,question:`解释查询 ${qid} 的已有证据，不要刷新数据`})).status,202);
    const follow=(await done(h.base)).sessions[0].turns.at(-1).run;
    assert.equal(follow.queries[0].queryId,qid);assert.equal(follow.counts.http,0);assert.equal(fetched,0);
    for(const question of ['show the previous token balance without refreshing',`explain the ERC20 balance from ${qid}`]){
      assert.equal((await post(h.base,'/api/runs',{sessionId:accepted.sessionId,question})).status,202);
      const historical=(await done(h.base)).sessions[0].turns.at(-1).run;
      assert.equal(historical.status,metadataError?'partial':'completed',question);
      assert.equal(historical.queries[0].queryId,qid);assert.equal(historical.counts.http,0);assert.equal(fetched,0);
    }
  }finally{await h.close();await rm(dir,{recursive:true,force:true});}
});

test('legacy ERC20 Runtime history imports with readable exact evidence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ledger-legacy-token-'));
  await offlineRun({token:true})({input:tokenQuestion,sessionId:'s_token_legacy',config:cfg(dir).chain,outputDirectory:dir,request:async()=>({content:''})});
  const h=await start(dir,async()=>{throw Error('history must not replay');});
  try{
    const s=(await state(h.base)).body;assert.equal(s.importWarnings,0);assert.equal(s.sessions.length,1);
    const turn=s.sessions[0].turns[0];assert.equal(turn.run.queries[0].tokenBalance.rawBalance,'9007199254740993');
    assert.equal((await fetch(h.base+`/api/evidence/${turn.id}/${turn.run.queries[0].queryId}`)).status,200);
  }finally{await h.close();await rm(dir,{recursive:true,force:true});}
});

test('ERC20 cancellation resumes its validated checkpoint after restart without repeating data HTTP',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ledger-resume-token-'));
  let h=await start(dir,offlineRun({token:true,cancelAfterQuery:true}));
  try{
    const accepted=await(await post(h.base,'/api/runs',{question:tokenQuestion})).json() as any;
    const first=(await done(h.base)).sessions[0].turns[0].run;assert.equal(first.status,'cancelled');assert.equal(first.resumable,true);
    await h.close();let fetched=0;h=await start(dir,offlineRun({token:true,onFetch:()=>fetched++}));
    assert.equal((await post(h.base,'/api/runs',{sessionId:accepted.sessionId,resumeRunId:first.runId})).status,202);
    const last=(await done(h.base)).sessions[0].turns.at(-1).run;
    assert.equal(last.status,'completed');assert.equal(last.queries[0].tokenBalance.rawBalance,'9007199254740993');assert.equal(fetched,0);
  }finally{await h.close();await rm(dir,{recursive:true,force:true});}
});
