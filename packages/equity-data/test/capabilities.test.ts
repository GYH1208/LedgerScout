import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCoverage, parseCapabilityArgs, inspectCapability } from '../src/capabilities.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('capability stdout redacts credential echoes in provider object keys',()=>{
  const dir=mkdtempSync(join(tmpdir(),'equity-cli-echo-')),key='fake-fmp-secret-property';
  try{
    const moduleUrl=new URL('../src/cli.ts',import.meta.url).href;
    const script=`globalThis.fetch=async input=>Response.json(String(input).includes('/profile')?[{symbol:'SPY',[process.env.FMP_API_KEY]:'echo'}]:[{symbol:'SPY',date:'2026-11-13',price:1,[process.env.FMP_API_KEY]:'echo'}]); const {runCapabilityCli}=await import(${JSON.stringify(moduleUrl)}); await runCapabilityCli(['--stage','market','--symbols','SPY']);`;
    const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,FMP_API_KEY:key,TWELVE_DATA_API_KEY:key,SEC_USER_AGENT:'LedgerScout contact@ledgerscout.invalid',EQUITY_OUTPUT_DIRECTORY:dir,MAX_RETRIES:'0'}});
    assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.includes(key),false);assert.equal(result.stderr.includes(key),false);
    assert.equal(JSON.parse(result.stdout).coverage.complete,false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('capability selection requires explicit bounded symbols and separate stages', () => {
  assert.deepEqual(parseCapabilityArgs(['--stage','stocks','--symbols','AAPL,MSFT']), {stage:'stocks',symbols:['AAPL','MSFT'],config:false});
  assert.throws(()=>parseCapabilityArgs(['--stage','stocks']));
  assert.throws(()=>parseCapabilityArgs(['--stage','stocks','--symbols','A,B,C,D,E,F']));
  assert.equal(parseCapabilityArgs(['--config']).config,true);
  assert.equal(parseCapabilityArgs(['--stage','market']).symbols.length,13);
});
test('config CLI makes no HTTP request or secret-bearing output',()=>{
  const result=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'--config'],{encoding:'utf8',env:{...process.env,FMP_API_KEY:'test-private-key',TWELVE_DATA_API_KEY:'test-private-key',SEC_USER_AGENT:'Tool contact@real-domain.org'}});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.includes('test-private-key'),false);
  assert.equal(result.stdout.includes('contact@real-domain.org'),false);
  assert.equal(JSON.parse(result.stdout).market,'configured-unverified');
});
test('capability report describes actual response and never completes from demos', () => {
  const row=inspectCapability('historical-price-eod/light','AAPL',[{date:'2026-11-13',price:1}]);
  assert.equal(row.status,'available'); assert.equal(row.historyLength,1); assert.equal(row.adjustment,'unknown');
  assert.deepEqual(row.fields,['date','price']);
  const coverage=assessCoverage([row]);
  assert.equal(coverage.complete,false); assert.equal(coverage.marketCovered,0); assert.equal(coverage.stockCovered,0);
});
