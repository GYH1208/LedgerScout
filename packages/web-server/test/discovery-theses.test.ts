import test from 'node:test';
import assert from 'node:assert/strict';
import type {FrozenCompany,ThesisInput} from '../../equity-data/src/discovery-types.js';
import {validateThesis,compareSnapshots,evaluateConditions} from '../src/discovery-theses.js';

const thesis=():ThesisInput=>({title:'Workflow adoption',statement:'Paid adoption may improve cash flow.',theme:'workflow',symbols:['MSFT'],sourceJobId:'dj_source',support:[],opposing:[],gaps:['AI revenue unknown'],conditions:[{id:'c1',kind:'metric',description:'Revenue exceeds 100',field:'revenue',op:'gt',value:100,period:'2025-01-01/2025-12-31'}],invalidation:'Paid adoption stalls.',nextCheck:'2027-02-28',horizonMonths:24});
const company=(value:number|null,period='2025-01-01/2025-12-31',unit='USD',definition='Annual revenue'):FrozenCompany=>({symbol:'MSFT',snapshotId:'q_old',documentIds:[],snapshot:{security:{symbol:'MSFT',name:'Microsoft',cik:'0000789019',exchange:'NASDAQ',currency:'USD',country:'US',kind:'common-stock'},financials:{annual:[],quarterly:[],warnings:[]},metrics:{revenue:{value,period,unit,definition,sourceRefs:[]}},filings:[],sourceRefs:[],fetchedAt:'2026-01-01T00:00:00.000Z',warnings:[]}});

test('thesis input validates bounded plain fields and denies executable conditions',()=>{
  const input=thesis();assert.deepEqual(validateThesis(input),input);
  for(const invalid of [{...input,horizonMonths:18},{...input,nextCheck:'2027-02-30'},{...input,sql:'SELECT 1'},{...input,title:'x'.repeat(201)},{...input,symbols:['MSFT','MSFT']},{...input,conditions:[{...input.conditions[0],field:'revenue; process.exit()'}]},{...input,conditions:[{...input.conditions[0],value:Infinity}]},{...input,conditions:[{...input.conditions[0],script:'return true'}]}])assert.throws(()=>validateThesis(invalid));
  const result=validateThesis(input);result.gaps.push('new');assert.equal(input.gaps.length,1);
});

test('snapshot differences distinguish missing, restated, new period, unit and definition mismatch',()=>{
  assert.equal(compareSnapshots([company(100)],[company(110)])[0]!.kind,'restatement');
  assert.equal(compareSnapshots([company(100)],[company(110)])[0]!.delta,10);
  assert.equal(compareSnapshots([company(100)],[company(100)])[0]!.kind,'unchanged');
  assert.equal(compareSnapshots([company(100)],[company(110,'2026-01-01/2026-12-31')])[0]!.kind,'new-period');
  assert.equal(compareSnapshots([company(100)],[company(null)])[0]!.kind,'missing');
  assert.equal(compareSnapshots([company(100)],[])[0]!.kind,'missing');
  assert.equal(compareSnapshots([company(100)],[company(110,undefined,'EUR')])[0]!.kind,'not-comparable');
  assert.equal(compareSnapshots([company(100)],[company(110,undefined,undefined,'Segment revenue')])[0]!.kind,'not-comparable');
});

test('conditions use exact requested periods, never treat missing as zero and keep manual checks manual',()=>{
  const condition=thesis().conditions[0]!;
  assert.equal(evaluateConditions([condition],[company(110)])[0]!.status,'met');
  assert.equal(evaluateConditions([condition],[company(100)])[0]!.status,'not-met');
  assert.equal(evaluateConditions([condition],[company(null)])[0]!.status,'unknown');
  assert.equal(evaluateConditions([condition],[company(110,'2026-01-01/2026-12-31')])[0]!.status,'unknown');
  assert.equal(evaluateConditions([condition],[company(110),{...company(110),symbol:'GOOG'}])[0]!.status,'unknown');
  assert.equal(evaluateConditions([{id:'manual',kind:'manual',description:'Check customer renewal'}],[company(110)])[0]!.status,'manual');
});

test('citations accept document chunk locations and named conditions stay within authorized symbols',()=>{
  const input={...thesis(),support:[{chunkId:'d_source:c0',quote:'Paid adoption'}]};
  assert.deepEqual(validateThesis(input).support,input.support);
  const named={...input.conditions[0]!,symbol:'MSFT'};
  assert.equal(evaluateConditions([named],[company(110),{...company(120),symbol:'GOOG'}])[0]!.status,'met');
  assert.equal(evaluateConditions([{...named,symbol:'NVDA'}],[company(110)])[0]!.status,'unknown');
  assert.throws(()=>validateThesis({...input,conditions:[{...named,symbol:'GOOG'}]}),/symbol|outside/i);
  assert.throws(()=>validateThesis({...input,support:[{chunkId:'d_source:arbitrary',quote:'Paid adoption'}]}),/chunk/i);
});
