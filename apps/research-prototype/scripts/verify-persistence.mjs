// Real local HTTP + SQLite + Pi Runtime. Only upstream suppliers are offline.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root=fileURLToPath(new URL('../../../',import.meta.url)),out=join(root,'docs/design/qa');
const directory=await mkdtemp(join(tmpdir(),'ledger-browser-sqlite-'));
const ui=process.env.PROTOTYPE_URL??'http://127.0.0.1:4173';
const question='查询 0x1111111111111111111111111111111111111111 当前 ETH 余额';
const checks=[],errors=[];
let api,browser;
async function start(mode='serve') {
 const child=spawn(process.execPath,['--import','tsx',join(root,'packages/web-server/test/fixtures/crash-server.ts'),directory,mode],{cwd:root,stdio:['ignore','pipe','pipe']});
 let output='',diagnostic='',resolvePause;const paused=new Promise(r=>resolvePause=r);
 const base=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Offline server startup timed out: '+diagnostic));},10000);
  child.stdout.on('data',data=>{output+=String(data);if(output.includes('PAUSED'))resolvePause();const match=output.match(/READY (\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}});
  child.stderr.on('data',data=>diagnostic+=String(data));
  child.on('error',reject);child.on('exit',()=>{clearTimeout(timer);reject(Error('Offline server exited: '+diagnostic));});
 });
 return{base,paused,async stop(){if(child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.kill('SIGKILL');await exited;}};
}
async function state(){return(await fetch(api.base+'/api/state')).json();}
async function finish(){const deadline=Date.now()+15000;while(Date.now()<deadline){const s=await state();if(!s.busy)return s;await new Promise(r=>setTimeout(r,50));}throw Error('Offline run timed out');}
async function submit(page,text){
 await page.getByRole('textbox',{name:await page.getByRole('textbox',{name:'研究问题',exact:true}).count()?'研究问题':'继续提问',exact:true}).fill(text);
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/runs'&&r.request().method()==='POST');
 await page.getByRole('button',{name:await page.getByRole('button',{name:'开始研究',exact:true}).count()?'开始研究':'继续研究',exact:true}).click();
 const r=await response;assert.equal(r.status(),202);return r.json();
}
try{
 api=await start();browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1024}});page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const u=new URL(route.request().url());
  try{const response=await route.fetch({url:api.base+u.pathname+u.search});await route.fulfill({response});}
  catch{await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'本地测试服务正在重启'})}).catch(()=>{});}
 });
 await page.goto(ui+'/?mode=live');const accepted=await submit(page,question);let s=await finish(),r=s.sessions[0].turns[0].run;assert.equal(r.status,'completed');const q=r.queries[0].queryId;
 await api.stop();api=await start();await page.reload();await page.getByRole('button').filter({hasText:question.slice(0,28)}).click();
 await page.getByText('会话与证据保存在本机',{exact:true}).waitFor();
 await page.locator('.live-answer').filter({hasText:r.runId}).waitFor();await page.locator('.live-query-link').last().click();await page.getByRole('heading',{name:'精确余额',exact:true}).waitFor();
 assert((await page.locator('.evidence-panel').innerText()).includes('1000000000000000001'));await page.getByRole('button',{name:'关闭证据',exact:true}).click();checks.push('subprocess restart retains conversation and exact evidence');
 await submit(page,`解释查询 ${q} 的已有证据，不要刷新数据`);s=await finish();assert.equal(s.sessions[0].turns.at(-1).run.counts.http,0);checks.push('historical follow-up uses original evidence with zero data HTTP');
 await api.stop();api=await start('checkpoint');await submit(page,question);await api.paused;await api.stop();api=await start();
 await page.getByRole('heading',{name:'查询已中断',exact:true}).waitFor();
 assert.equal((await state()).busy,false);await mkdir(out,{recursive:true});await page.screenshot({path:join(out,'sqlite-offline-interrupted-desktop.png')});
 const resumed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/runs'&&r.request().method()==='POST');await page.getByRole('button',{name:'恢复本轮查询',exact:true}).last().click();assert.equal((await resumed).status(),202);
 s=await finish();const last=s.sessions[0].turns.at(-1).run;assert.equal(last.status,'completed');assert.equal(last.counts.http,3);checks.push('SIGKILL becomes interrupted and explicit recovery reuses completed data');
 await page.locator('.live-answer').filter({hasText:last.runId}).waitFor();await page.setViewportSize({width:390,height:844});await page.locator('.live-query-link').last().click();const panel=page.getByRole('dialog',{name:'真实证据',exact:true});await panel.waitFor();assert((await panel.innerText()).includes('1000000000000000001'));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:join(out,'sqlite-offline-evidence-mobile.png')});checks.push('mobile restored evidence drawer preserves precision without overflow');assert.deepEqual(errors,[]);
 await writeFile(join(out,'sqlite-persistence-results.json'),JSON.stringify({status:'passed',transport:'forwarded to actual local HTTP/SQLite/Pi Runtime; offline upstream responses only',sessionId:accepted.sessionId,checks,errors},null,2));console.log(JSON.stringify({status:'passed',checks,errors},null,2));
}finally{await browser?.close();await api?.stop();await rm(directory,{recursive:true,force:true});}
