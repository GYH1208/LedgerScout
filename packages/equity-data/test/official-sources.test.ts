import test from 'node:test';
import assert from 'node:assert/strict';
import {validateOfficialSource,discoverOfficialLinks,readOfficialPage} from '../src/official-sources.js';
import type {OfficialSource} from '../src/discovery-types.js';
const source:OfficialSource={id:'news',kind:'index',url:'https://investor.example.com/news/',allowedHosts:['investor.example.com'],pathPrefix:'/news/',maxPages:2,verification:'verified'};

test('source scope rejects deceptive hosts, URL normalization bypasses and ambiguous paths',()=>{
 assert.equal(validateOfficialSource({...source,verification:'pending'}).verification,'pending');
 for(const url of ['http://investor.example.com/news/','https://investor.example.com:443/news/','https://u:p@investor.example.com/news/','https://127.1/news/','https://foo.localhost/news/','https://foo.internal/news/','https://investor.example.com/news/%2e%2e/private','https://investor.example.com/news/%2fprivate','https://investor.example.com/news/../news/','https://investor.example.com.evil.com/news/'])assert.throws(()=>validateOfficialSource({...source,url}),/SOURCE/);
 assert.throws(()=>validateOfficialSource({...source,pathPrefix:'/new'}),/SOURCE/);
});

test('index only discovers actual same-scope HTML links and an explicit next link',()=>{
 const r=discoverOfficialLinks(`<a href="release.html">Results</a><a href="/news/report.pdf">PDF</a><a href="/news/a.png">Image</a><a href="https://evil.example/news/x">Evil</a><a href="/private/a">Private</a><a href="javascript:evil()">Bad</a><a href="/news/%2e%2e/news/x">Traversal</a><a rel="next" href="?page=2">Next</a><a href="release.html#facts">Duplicate</a><script>"/news/invented.html"</script>`,source,source.url);
 assert.deepEqual(r,{documents:['https://investor.example.com/news/release.html'],nextPage:'https://investor.example.com/news/?page=2'});
 assert.equal(discoverOfficialLinks('<p>Next page 2</p>',source,source.url).nextPage,undefined);
 assert.deepEqual(discoverOfficialLinks('<a href="https://evil.example/news/x">next</a>',source,source.url),{documents:[]});
});

test('reader requires verified exact scope and invokes the shared budget immediately before dispatch',async()=>{
 const events:string[]=[];
 const fetcher:typeof fetch=async(url,options)=>{events.push(`fetch:${String(url)}`);assert.equal(options?.redirect,'error');return new Response('<h1>Results</h1>',{headers:{'content-type':'text/html'}});};
 const r=await readOfficialPage(source,source.url,{fetch:fetcher,beforeRequest:()=>{events.push('budget');}});
 assert.equal(r.html,'<h1>Results</h1>');assert.deepEqual(events,['budget',`fetch:${source.url}`]);assert.ok(Date.parse(r.fetchedAt));
 await assert.rejects(readOfficialPage({...source,verification:'pending'},source.url,{fetch:fetcher}),/VERIFIED/);
 await assert.rejects(readOfficialPage(source,'https://investor.example.com/newstuff',{fetch:fetcher}),/SOURCE/);
 assert.equal(events.length,2);
});

test('reader rejects redirects, binary content, errors and bounded streaming bodies without retry',async()=>{
 for(const response of [new Response('',{status:302,headers:{location:'https://evil.example'}}),new Response('bad',{status:403}),new Response('PDF',{headers:{'content-type':'application/pdf'}}),new Response('x',{headers:{'content-length':'2097153'}}),new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1200000));c.enqueue(new Uint8Array(1200000));c.close();}}))]){
  let requests=0;await assert.rejects(readOfficialPage(source,source.url,{fetch:async()=>{requests++;return response;}}),/RESPONSE|REDIRECT|HTTP/);assert.equal(requests,1);
 }
});

test('cancel before or during an awaited budget hook never dispatches a late request',async()=>{
 let requests=0;const controller=new AbortController();const fetcher:typeof fetch=async()=>{requests++;return new Response('x');};
 controller.abort();await assert.rejects(readOfficialPage(source,source.url,{fetch:fetcher,signal:controller.signal}),/CANCELLED/);
 const another=new AbortController();let release!:()=>void;const hook=new Promise<void>(resolve=>{release=resolve;});
 const pending=readOfficialPage(source,source.url,{fetch:fetcher,signal:another.signal,beforeRequest:()=>hook});
 another.abort();await assert.rejects(pending,/CANCELLED/);release();await new Promise(resolve=>setImmediate(resolve));assert.equal(requests,0);
});

test('links preserve raw URL checks before URL resolution normalizes explicit ports',()=>{
 assert.deepEqual(discoverOfficialLinks('<a href="https://investor.example.com:443/news/private">port</a><a href="//investor.example.com:443/news/private2">port2</a>',source,source.url),{documents:[]});
});

test('header rejection cancels the response body instead of leaving a public stream open',async()=>{
 let cancelled=false;
 const response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/pdf'}});
 await assert.rejects(readOfficialPage(source,source.url,{fetch:async()=>response}),/RESPONSE_TYPE/);
 assert.equal(cancelled,true);
});

test('public DNS validation rejects private, reserved and mixed DNS answers before budget dispatch',async()=>{
 for(const address of ['127.0.0.1','10.0.0.1','100.64.0.1','169.254.1.1','172.16.0.1','192.168.1.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::1']){
  let budget=0,dispatch=0;
  await assert.rejects(readOfficialPage(source,source.url,{lookup:async()=>[{address:'93.184.216.34',family:4},{address,family:address.includes(':')?6:4}],beforeRequest:()=>{budget++;},fetch:async()=>{dispatch++;return new Response('<p>x</p>',{headers:{'content-type':'text/html'}});}}),/SOURCE_PRIVATE_ADDRESS/);
  assert.equal(budget,0);assert.equal(dispatch,0);
 }
});

test('fixed document sources do not authorize other pages or altered queries',async()=>{
 const fixed:OfficialSource={...source,kind:'document',url:'https://investor.example.com/news/release?format=html'};
 await assert.rejects(readOfficialPage(fixed,'https://investor.example.com/news/release?format=json',{fetch:async()=>{throw Error('must never dispatch');}}),/SOURCE_SCOPE/);
});

test('HTTP429 remains distinguishable so the acquisition batch can stop immediately',async()=>{
 await assert.rejects(readOfficialPage(source,source.url,{fetch:async()=>new Response('rate limited',{status:429})}),/OFFICIAL_RATE_LIMIT/);
});
