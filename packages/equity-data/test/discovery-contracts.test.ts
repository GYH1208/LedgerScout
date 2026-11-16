import test from 'node:test';
import assert from 'node:assert/strict';
import {validateUniverse,THEMES} from '../src/discovery-types.js';
test('discovery universe is bounded, explicit and never self-certifies edited sources',()=>{
  const member={symbol:'MSFT',themes:['workflow'],sources:[]};
  assert.equal(validateUniverse([member])[0]!.verification,'pending');assert.equal(THEMES.length,4);
  assert.throws(()=>validateUniverse(Array.from({length:31},(_,i)=>({...member,symbol:`A${i}`}))),/30/);
  assert.throws(()=>validateUniverse([member,member]),/duplicate/i);
  assert.throws(()=>validateUniverse([{...member,themes:['other']}]),/theme/i);
  assert.throws(()=>validateUniverse([{...member,verification:'verified'}]),/field/i);
  assert.throws(()=>validateUniverse([{...member,sources:[{id:'s',kind:'document',url:'http://127.0.0.1/admin',allowedHosts:['127.0.0.1'],pathPrefix:'/'}]}]),/source|URL/i);
  const source={id:'ir',kind:'index',url:'https://www.microsoft.com/investor/',allowedHosts:['www.microsoft.com'],pathPrefix:'/investor/',maxPages:2};
  const row=validateUniverse([{...member,sources:[source]}])[0]!;
  assert.equal(row.sources[0]!.verification,'pending');
});
