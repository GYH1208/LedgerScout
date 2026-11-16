import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildDocument,retrieveChunks} from '../src/documents.js';

const input={id:'filing-1',symbol:'ACME',cik:'0000000001',url:'https://www.sec.gov/example.htm',sourceKind:'sec' as const,fetchedAt:'2026-11-16T00:00:00.000Z'};
const business='Our workflow application has paying customers who use artificial intelligence to automate document processing. ';

test('indexes the business body after linked table of contents and removes executable and navigation text',()=>{
 const d=buildDocument({...input,html:`<html><head><title>Annual &amp; report</title><script>evil()</script><style>.secret{}</style></head><body><nav>Menu</nav><p>Table of contents</p><p><a href="#business">Item 1. Business</a> 3</p><p><a href="#risk">Item 1A. Risk Factors</a> 9</p><h2 id="business">Item 1. Business</h2><p>${business.repeat(4)}A &amp; B &#8212; tools.</p><h2>Item 1A. Risk Factors</h2><p>${'Competition and inference costs may reduce margins. '.repeat(5)}</p><h2>Item 7. Management’s Discussion and Analysis</h2><p>${'Revenue grew as paying customers expanded usage. '.repeat(5)}</p><h2>Item 8. Financial Statements and Supplementary Data</h2><p>${'Notes to financial statements and revenue recognition. '.repeat(5)}</p><footer>Footer links</footer><p hidden>Hidden lie</p></body></html>`});
 assert.equal(d.title,'Annual & report');
 assert.deepEqual(d.sections.filter(s=>s.kind!=='other').map(s=>s.kind),['business','risk','mda','financial']);
 const s=d.sections.find(s=>s.kind==='business')!;
 assert.ok(d.text.slice(s.start,s.end).includes(business));
 assert.ok(!d.text.includes('evil')&&!d.text.includes('Footer links')&&!d.text.includes('Hidden lie')&&!d.text.includes('Menu'));
 assert.ok(d.text.includes('A & B — tools.'));
 for(const c of d.chunks){assert.equal(d.text.slice(c.start,c.end),c.text);assert.equal(c.hash,createHash('sha256').update(c.text).digest('hex'));assert.equal(c.cik,input.cik);assert.equal(c.documentId,input.id);}
});

test('indexes evidence well past the former opening excerpt and retrieves lexical matches with stable paging',()=>{
 const d=buildDocument({...input,html:`<h1>Item 1. Business</h1>${Array.from({length:60},()=>`<p>${'General products and services. '.repeat(50)}</p>`).join('')}<h2>Item 7. Management Discussion and Analysis</h2><p>${'Agentic paid adoption grew with workflow subscriptions. '.repeat(120)}</p>`});
 const r=retrieveChunks(d,'agentic paid adoption',{limit:1});
 assert.equal(r.chunks.length,1);assert.ok(r.chunks[0]!.start>30000);assert.ok(r.total>1);assert.equal(r.nextOffset,1);
 const second=retrieveChunks(d,'agentic paid adoption',{offset:r.nextOffset!,limit:1});assert.notEqual(second.chunks[0]!.id,r.chunks[0]!.id);
 assert.throws(()=>retrieveChunks(d,'x',{offset:-1}),/PAGINATION/);
 assert.ok(retrieveChunks(d,'absent-word').chunks.every(c=>c.text===d.text.slice(c.start,c.end)));
});

test('a navigation-only or unlocatable heading is never claimed as a business chapter',()=>{
 const d=buildDocument({...input,html:`<p><a href="#b">Item 1. Business</a></p><p>${business.repeat(10)}</p>`});
 assert.ok(d.sections.every(s=>s.confidence==='fallback'&&s.kind==='other'));
 assert.ok(d.warnings.some(w=>/section|章节/i.test(w)));
 assert.ok(d.chunks.length>0);
});

test('unlinked table-of-contents titles cannot promote subsequent cover text into a business section',()=>{
 const d=buildDocument({...input,html:`<p>TABLE OF CONTENTS</p><p>Item 1. Business</p><p>3</p><p>${'Cover page security registration and signature information. '.repeat(8)}</p>`});
 assert.ok(!d.sections.some(s=>s.kind==='business'));
 assert.ok(d.warnings.some(w=>/section|章节/i.test(w)));
});

test('indexed text is bounded with an explicit extraction warning and oversized HTML is rejected',()=>{
 const d=buildDocument({...input,html:`<p>${'disclosure '.repeat(60000)}</p>`});
 assert.ok(d.text.length<=500000);assert.ok(d.warnings.some(w=>/truncat|limit/i.test(w)));
 const large=buildDocument({...input,html:`<h2>Item 1. Business</h2><p>${'disclosure '.repeat(200000)}</p>`});
 assert.ok(large.text.length<=500000);assert.ok(large.warnings.some(w=>/truncat|limit/i.test(w)));assert.ok(large.sections.some(s=>s.kind==='business'));
 assert.throws(()=>buildDocument({...input,html:'x'.repeat(16777217)}),/RESPONSE_SIZE/);
});
