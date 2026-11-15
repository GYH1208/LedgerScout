import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { runAgent, loadRuntimeConfig, createDeepSeekRequest, type RunResult } from '@ledgerscout/agent-runtime';
import { redact } from '@ledgerscout/chain-data';
import { WebStore } from './storage.js';
import { publicQuery, validId } from './views.js';
import { initializeHistory, loadEvidence, recovery } from './history.js';

type Config = ReturnType<typeof loadRuntimeConfig>;
class HttpError extends Error { constructor(readonly status: number, message: string) {super(message);} }
async function readBody(req: IncomingMessage) {
  let size=0;const chunks:Buffer[]=[];
  for await (const chunk of req) {size+=Buffer.byteLength(chunk);if(size>16384)throw new HttpError(413,'请求过大');chunks.push(Buffer.from(chunk));}
  try {const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v as Record<string,unknown>;}
  catch {throw new HttpError(400,'请求必须为 JSON 对象');}
}
function send(res:ServerResponse,status:number,value:unknown) {res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));}

export function createWebServer(options: {config?:()=>Config;run?:typeof runAgent}={}) {
  const load=options.config??loadRuntimeConfig;
  let store:WebStore|undefined,base='',initError='',initialized=false,allowWrites=true;
  let active:{id:string;controller:AbortController;task?:Promise<void>}|undefined;
  let resolveReady:(v:boolean)=>void=()=>{},resolveShutdown:()=>void=()=>{};
  const ready=new Promise<boolean>(resolve=>resolveReady=resolve),shutdown=new Promise<void>(resolve=>resolveShutdown=resolve);
  const secrets=()=>{try{const c=load();return[c.key,c.chain.alchemyKey,c.chain.etherscanKey].filter(Boolean);}catch{return[];}};
  const clean=(v:unknown)=>redact(v,secrets());
  const configuration=()=>{
    try {const c=load(),configured={deepseek:Boolean(c.key),alchemy:Boolean(c.chain.alchemyKey),etherscan:Boolean(c.chain.etherscanKey)};return{ready:Object.values(configured).every(Boolean),configured,model:c.model};}
    catch{return{ready:false,configured:{deepseek:false,alchemy:false,etherscan:false},model:'deepseek-flash',error:'本地配置无法读取，请检查 .env 格式。'};}
  };
  const server=createServer((req,res)=>{void handle(req,res).catch(error=>{
    if(!res.headersSent)send(res,error instanceof HttpError?error.status:500,{error:error instanceof HttpError?error.message:'本地记录读取或保存失败，请检查存储目录与服务日志后重试。'});
    else res.end();
  });});
  // Bind first: EADDRINUSE must never mutate the existing service's jobs.
  // The SQLite owner lease additionally guards another listener/port.
  server.once('listening',()=>{void(async()=>{
    try {base=load().outputDirectory;store=new WebStore(join(base,'web.sqlite'));await initializeHistory(base,store,secrets());initialized=true;resolveReady(true);}
    catch {initError='本地会话数据库无法打开或已被其他服务占用。请保留原数据，检查目录权限、数据库与重复服务后重启。';store?.close();store=undefined;resolveReady(false);}
  })();});
  server.once('error',()=>resolveReady(false));
  server.once('close',()=>{void(async()=>{
    active?.controller.abort(new Error('Server closed'));
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([active?.task??Promise.resolve(),new Promise<void>(r=>{timer=setTimeout(r,6500);})]);}
    finally {if(timer)clearTimeout(timer);allowWrites=false;store?.close();resolveShutdown();}
  })();});

  async function handle(req:IncomingMessage,res:ServerResponse) {
    if(!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(req.headers.host??''))throw new HttpError(403,'仅允许本地访问');
    const origin=req.headers.origin;if(origin&&!['http://127.0.0.1:4173','http://localhost:4173'].includes(origin))throw new HttpError(403,'不允许此请求来源');
    if(req.method==='POST'&&(req.headers['x-ledgerscout-client']!=='web'||!/^application\/json(?:;|$)/.test(req.headers['content-type']??'')))throw new HttpError(403,'缺少本地客户端请求标记');
    if(!initialized||!store||initError)throw new HttpError(503,initError||'本地历史记录正在准备，请稍后重试。');
    const db=store,url=new URL(req.url??'/','http://127.0.0.1');
    if(req.method==='GET'&&url.pathname==='/api/state') {
      // Keep the running flag consistent with the SQL snapshot while asynchronous
      // checkpoint reads run. A task may finish before this response is sent.
      const snapshot=db.list(),busyAtSnapshot=Boolean(active);
      const sessions=await Promise.all(snapshot.sessions.map(async s=>({...s,turns:await Promise.all(s.turns.map(async job=>{
        const candidate=job.status==='interrupted'||job.run?.resumable||job.status==='failed'&&!job.run&&job.runId;
        const recover=candidate?await recovery(base,job):undefined;
        return{id:job.id,question:job.question,status:job.status,progress:job.progress,error:job.error,resumable:Boolean(recover),
          ...(job.run?{run:{...job.run,resumable:Boolean(recover)}}:{}),...(!job.run&&recover?{recovery:recover}:{})};
      }))})));
      return send(res,200,clean({...configuration(),busy:busyAtSnapshot,sessions,hasMoreSessions:snapshot.hasMoreSessions,importWarnings:db.importWarnings()}));
    }
    if(req.method==='POST'&&url.pathname==='/api/runs') {
      const body=await readBody(req);
      if(Object.keys(body).some(k=>!['question','sessionId','resumeRunId'].includes(k)))throw new HttpError(400,'不支持的请求字段');
      const {question,sessionId,resumeRunId}=body,resume=resumeRunId!==undefined;
      if(sessionId!==undefined&&!validId(sessionId,'s')||resumeRunId!==undefined&&!validId(resumeRunId,'r'))throw new HttpError(400,'无效的会话或运行 ID');
      if(resume?!sessionId||question!==undefined:typeof question!=='string'||!question.trim()||question.length>4000)throw new HttpError(400,'恢复不能附带新问题；研究问题需为 1–4000 字符');
      if(sessionId&&!db.hasSession(String(sessionId)))throw new HttpError(404,'未找到此 Web 会话');
      if(resume) {
        const source=db.findRun(String(sessionId),String(resumeRunId));if(!source)throw new HttpError(404,'未找到此会话的源运行');
        if(!await recovery(base,source))throw new HttpError(409,'源运行不可恢复、证据校验失败或已被恢复');
      }
      if(active)throw new HttpError(409,'已有查询正在执行，请等待或取消后再试');
      if(!configuration().ready)throw new HttpError(503,'请先在本地 .env 配置 DeepSeek、Alchemy 和 Etherscan 密钥');
      const config=load(),secretValues=[config.key,config.chain.alchemyKey,config.chain.etherscanKey].filter(Boolean);
      const safe=(text:string)=>String(redact(text,secretValues));
      const questionText=resume?'恢复上一次运行':safe(String(question).trim());
      const accepted=db.accept({...(sessionId?{sessionId:String(sessionId)}:{}),title:questionText.slice(0,100),question:questionText,date:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()),...(resume?{resumeOf:String(resumeRunId)}:{})});
      const controller=new AbortController(),running={id:accepted.jobId,controller,task:undefined as Promise<void>|undefined};active=running;
      send(res,202,accepted);
      running.task=(async()=>{
        try {
          const result=await(options.run??runAgent)({input:resume?'':String(question).trim(),sessionId:accepted.sessionId,...(resume?{resumeRunId:String(resumeRunId)}:{}),config:config.chain,
            request:options.run?async()=>{throw Error('Injected runner must provide its own model');}:createDeepSeekRequest(config),outputDirectory:base,signal:controller.signal,secrets:secretValues,
            onEvent:event=>{
              if(!allowWrites)throw Error('Service stopped');
              try {
                if(typeof event.runId==='string')db.bindRun(accepted.jobId,event.runId);
                db.progress(accepted.jobId,{type:event.type,...(typeof event.name==='string'?{name:safe(event.name).slice(0,100)}:{})});
              } catch(error) {controller.abort(new Error('Durable Web recording failed'));throw error;}
            }});
          if(allowWrites)db.finish(accepted.jobId,redact(result,secretValues) as RunResult);
        } catch {
          controller.abort();
          if(allowWrites){try{db.fail(accepted.jobId,'本地运行初始化或记录保存失败，请检查配置与证据目录。');}catch{initError='本地会话记录无法保存，查询已停止。请保留数据并检查存储目录后重启服务。';}}
        } finally {if(active===running)active=undefined;}
      })();
      return;
    }
    const cancellation=/^\/api\/runs\/(j_[a-zA-Z0-9_-]+)\/cancel$/.exec(url.pathname);
    if(req.method==='POST'&&cancellation) {
      if(!db.get(cancellation[1]!))throw new HttpError(404,'运行不存在');
      const requested=active?.id===cancellation[1];if(requested)active!.controller.abort(new Error('User cancelled'));return send(res,200,{requested});
    }
    const evidence=/^\/api\/evidence\/(j_[a-zA-Z0-9_-]+)\/(q_[a-zA-Z0-9_-]+)$/.exec(url.pathname);
    if(req.method==='GET'&&evidence) {
      const job=db.get(evidence[1]!),ref=db.refs(evidence[1]!).find(q=>q.queryId===evidence[2]);if(!job||!ref)throw new HttpError(404,'该运行未引用此证据');
      let q;try{q=await loadEvidence(base,job,ref);}catch{throw new HttpError(404,'此证据缺失、已改变或无法通过校验，请检查本地原始记录。');}
      const rawOffset=url.searchParams.get('offset')??'0';if(!/^\d{1,6}$/.test(rawOffset))throw new HttpError(400,'无效分页');const offset=Number(rawOffset);
      const rows=q.kind==='list_asset_transfers'?[...(q.data.incoming?.transfers??[]),...(q.data.outgoing?.transfers??[])]:q.kind==='list_normal_transactions'?q.data.transactions??[]:[];
      const allowed=['id','hash','blockNumber','timestamp','from','to','direction','category','asset','rawValue','decimalsHex','tokenAddress','valueWei','wei','eth','failed','isError','conflictingDuplicate'];
      const records=rows.slice(offset,offset+10).map((row:Record<string,unknown>)=>Object.fromEntries(allowed.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]])));
      return send(res,200,clean({query:publicQuery(q),records,offset,total:rows.length,nextOffset:offset+records.length<rows.length?offset+records.length:null,ensResolutions:job.run?.ensResolutions??[]}));
    }
    throw new HttpError(404,'接口不存在');
  }
  return Object.assign(server,{ready,shutdown});
}
