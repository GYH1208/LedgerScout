import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EquityStore } from '../src/equity-store.js';

test('equity pool versions and fixed-domain sessions persist without changing the Ethereum database', async () => {
  const dir = await mkdtemp(join(tmpdir(),'equity-store-'));
  let store: EquityStore | undefined;
  try {
    store = new EquityStore(dir);
    assert.deepEqual(store.pool().symbols, []);
    const pool = store.setPool(['AAPL','MSFT']);
    assert.equal(pool.version,1);
    assert.throws(()=>store!.setPool(Array.from({length:11},(_,i)=>`A${i}`)),/10/);
    assert.throws(()=>store!.setPool(['AAPL','AAPL']),/duplicate/i);
    const job=store.accept('AAPL','解释现金流');
    store.finish({...job,status:'completed',answer:{facts:['现金流取自证据'],analysis:'',dataGaps:[],sourceRefs:[]}});
    assert.throws(()=>store!.accept('MSFT','换股票',job.sessionId),/fixed|symbol/i);
    store.close(); store = new EquityStore(dir);
    assert.deepEqual(store.pool().symbols,['AAPL','MSFT']);
    assert.equal(store.sessions()[0]!.researchDomain,'us-equity');
    assert.equal(store.sessions()[0]!.turns[0]!.answer!.facts[0],'现金流取自证据');
  } finally {store?.close();await rm(dir,{recursive:true,force:true});}
});

test('evidence is immutable and reads fail on changed bytes or unregistered IDs', async () => {
  const dir=await mkdtemp(join(tmpdir(),'equity-proof-'));const store=new EquityStore(dir);
  try {
    const proof=await store.evidence('AAPL','SEC',{value:'12345678901234567890'});
    assert.equal((await store.readEvidence(proof.id)).data.value,'12345678901234567890');
    await assert.rejects(store.readEvidence('q_unknown'),/evidence/i);
    await assert.rejects(store.readEvidence('../../.env'),/evidence|identity/i);
    await writeFile(join(dir,'equity','evidence',`${proof.id}.json`),'{}');
    await assert.rejects(store.readEvidence(proof.id),/hash|changed/i);
  } finally {store.close();await rm(dir,{recursive:true,force:true});}
});

test('restart marks active jobs interrupted without automatically running them', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'equity-restart-'));let store=new EquityStore(dir);
  try {
    const job=store.accept('AAPL','研究'); store.close();store=new EquityStore(dir);
    assert.equal(store.job(job.id)!.status,'interrupted');
    assert.equal(store.job(job.id)!.counts?.modelRequests,0);
    assert.throws(()=>store.accept('AAPL','跨域','s_ethereum'),/session/i);
  } finally{store.close();await rm(dir,{recursive:true,force:true});}
});
