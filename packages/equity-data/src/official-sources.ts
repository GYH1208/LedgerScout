import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';
import {parseDocument} from 'htmlparser2';
import type {OfficialSource} from './discovery-types.js';

type AnyNode=ReturnType<typeof parseDocument>['children'][number];
const MAX_BYTES=2*1024*1024;
const error=(code:string)=>Error(`OFFICIAL_${code}`);
function safeUrl(raw:string):URL {
 if(typeof raw!=='string'||raw.length>4000||/[\x00-\x20\\]/.test(raw)||!/^https:\/\//.test(raw))throw error('SOURCE_URL');
 // Inspect before WHATWG URL normalization removes dot segments or an explicit default port.
 const authority=raw.slice(8).split(/[/?#]/)[0]!;
 if(authority.includes('@')||authority.includes(':'))throw error('SOURCE_URL');
 let u:URL;try{u=new URL(raw);}catch{throw error('SOURCE_URL');}
 const h=u.hostname;
 if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)||h.endsWith('.')||isIP(h)||/(?:^|\.)(?:localhost|local|internal|intranet|home|lan|test|invalid|onion)$/.test(h)||u.username||u.password||u.port)throw error('SOURCE_HOST');
 const path=raw.slice(8+authority.length).split(/[?#]/)[0]||'/';
 if(/%(?:2e|2f|5c|25)/i.test(path)||path.split('/').some(p=>p==='.'||p==='..')||path.includes('//'))throw error('SOURCE_PATH');
 return u;
}
function inScope(url:URL,source:OfficialSource):boolean {
 const p=source.pathPrefix;
 return source.allowedHosts.includes(url.hostname)&&(p==='/'||url.pathname===p||url.pathname.startsWith(p.endsWith('/')?p:`${p}/`));
}
function htmlPath(url:URL):boolean {
 const name=url.pathname.split('/').at(-1)??'';
 return !name.includes('.')||/\.(?:html?|shtml|php|aspx?|jsp)$/i.test(name);
}

export function validateOfficialSource(source:OfficialSource):OfficialSource {
 if(!source||! /^[a-zA-Z0-9_-]{1,60}$/.test(source.id)||!['document','index','pdf'].includes(source.kind)||!['pending','verified'].includes(source.verification))throw error('SOURCE_CONFIG');
 const u=safeUrl(source.url);
 const validPath=source.kind==='pdf'?/\.pdf$/i.test(u.pathname):htmlPath(u);
 if(u.hash||!validPath||!Array.isArray(source.allowedHosts)||source.allowedHosts.length!==1||source.allowedHosts[0]!==u.hostname||typeof source.pathPrefix!=='string'||!source.pathPrefix.startsWith('/')||/[?#%\\\x00-\x20]/.test(source.pathPrefix)||source.pathPrefix.includes('//')||source.pathPrefix.split('/').some(p=>p==='.'||p==='..')||!inScope(u,source)||source.maxPages!==undefined&&![1,2].includes(source.maxPages))throw error('SOURCE_SCOPE');
 return{...source,url:u.href,allowedHosts:[...source.allowedHosts]};
}

export function discoverOfficialLinks(html:string,rawSource:OfficialSource,pageUrl:string):{documents:string[];nextPage?:string}{
 const source=validateOfficialSource(rawSource),page=safeUrl(pageUrl);
 if(!inScope(page,source))throw error('SOURCE_SCOPE');
 if(Buffer.byteLength(html)>MAX_BYTES)throw error('RESPONSE_SIZE');
 const documents=new Set<string>();let nextPage:string|undefined;
 const pending:AnyNode[]=parseDocument(html).children.slice().reverse();
 while(pending.length){
  const n=pending.pop()!;
  if(!('name'in n)||!('children'in n))continue;
  if(['script','style','template','noscript'].includes(n.name))continue;
  if(n.name==='a'&&n.attribs.href){
   try{
    const href=n.attribs.href.trim();
    // Reject dangerous raw path syntax before resolving relative URLs.
    if(/[\\\x00-\x20]/.test(href)||/%(?:2e|2f|5c|25)/i.test(href)||href.split(/[?#]/)[0]!.split('/').some(p=>p==='.'||p==='..'))continue;
    if(href.startsWith('//'))safeUrl(`https:${href}`);else if(/^[a-z][a-z0-9+.-]*:/i.test(href))safeUrl(href);
    const u=safeUrl(new URL(href,page).href);u.hash='';
    if(!inScope(u,source)||!htmlPath(u))continue;
    let label='';const texts=[...n.children];while(texts.length){const node=texts.shift()!;if(node.type==='text')label+=node.data;else if('children'in node)texts.unshift(...node.children);}
    const isNext=/(?:^|\s)next(?:\s|$)/i.test(n.attribs.rel??'')||/^(?:next(?: page)?\s*[›»→]?|[›»→]|下一页)$/i.test(label.trim());
    if(isNext){if(source.kind==='index'&&source.maxPages===2&&u.href!==page.href&&!nextPage)nextPage=u.href;continue;}
    if(u.href!==page.href)documents.add(u.href);
   }catch{/* An untrusted link cannot widen the registered scope. */}
  }
  for(let i=n.children.length-1;i>=0;i--)pending.push(n.children[i]!);
 }
 return{documents:[...documents],...(nextPage?{nextPage}:{})};
}

function publicAddress(address:string):boolean {
 if(isIP(address)===4){
  const [a,b,c]=address.split('.').map(Number) as [number,number,number,number];
  return a>0&&a<224&&a!==10&&a!==127&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0||b===88&&c===99))&&!(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113);
 }
 if(isIP(address)===6){
  const [first,second]=address.toLowerCase().split(':');const a=parseInt(first!,16),b=parseInt(second||'0',16);
  return a>=0x2000&&a<=0x3fff&&a!==0x2002&&a!==0x3fff&&!(a===0x2001&&(b<0x200||b===0xdb8));
 }
 return false;
}

type ReaderOptions={fetch?:typeof fetch;signal?:AbortSignal;beforeRequest?:()=>void|Promise<void>;lookup?:(host:string)=>Promise<{address:string;family:number}[]>};
export async function readOfficialPage(source:OfficialSource,url:string,options:ReaderOptions={}):Promise<{html:string;url:string;fetchedAt:string}>{
 if(source.kind==='pdf')throw error('SOURCE_SCOPE');
 const {bytes,...result}=await readOfficialBytes(source,url,options);
 const html=bytes.toString('utf8');if(html.includes('\0'))throw error('RESPONSE_TYPE');
 return {...result,html};
}

export async function readOfficialPdf(source:OfficialSource,options:ReaderOptions={}):Promise<{bytes:Buffer;url:string;fetchedAt:string}>{
 if(source.kind!=='pdf')throw error('SOURCE_SCOPE');
 const result=await readOfficialBytes(source,source.url,options);
 if(result.bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw error('RESPONSE_TYPE');
 return result;
}

/** No redirects/retries. Real requests pin a prevalidated public DNS address through TLS lookup. */
async function readOfficialBytes(rawSource:OfficialSource,url:string,options:ReaderOptions):Promise<{bytes:Buffer;url:string;fetchedAt:string}>{
 const source=validateOfficialSource(rawSource),target=safeUrl(url);
 if(source.verification!=='verified')throw error('SOURCE_NOT_VERIFIED');
 const pdf=source.kind==='pdf';
 if(target.hash||!inScope(target,source)||(pdf?!/\.pdf$/i.test(target.pathname):!htmlPath(target))||source.kind!=='index'&&target.href!==source.url)throw error('SOURCE_SCOPE');
 const accept=pdf?'application/pdf':'text/html, application/xhtml+xml';
 const controller=new AbortController();
 let timeout=false;
 const timer=setTimeout(()=>{timeout=true;controller.abort();},15000);
 const onAbort=()=>controller.abort();options.signal?.addEventListener('abort',onAbort,{once:true});
 const check=()=>{if(options.signal?.aborted)throw error('CANCELLED');if(controller.signal.aborted)throw error(timeout?'REQUEST_TIMEOUT':'CANCELLED');};
 let abortHandler:()=>void=()=>{};
 let response:Response|undefined;
 const aborted=new Promise<never>((_,reject)=>{abortHandler=()=>reject(error(timeout?'REQUEST_TIMEOUT':'CANCELLED'));controller.signal.addEventListener('abort',abortHandler,{once:true});});
 try{
  check();
  const operation=async()=>{
   // Injection is the offline test seam; real requests always validate and pin DNS.
   const addresses=options.lookup?await options.lookup(target.hostname):options.fetch?undefined:await lookup(target.hostname,{all:true,verbatim:true});check();
   if(addresses&&(!addresses.length||addresses.some(a=>!publicAddress(a.address))))throw error('SOURCE_PRIVATE_ADDRESS');
   await options.beforeRequest?.();check();
   response=options.fetch?await options.fetch(target.href,{redirect:'error',signal:controller.signal,headers:{accept}}):await pinnedRequest(target,addresses![0]!,controller.signal,accept);
   check();
   if(response.redirected||response.status>=300&&response.status<400)throw error('REDIRECT');
   if(!response.ok)throw error(response.status===429?'RATE_LIMIT':'HTTP_ERROR');
   if(response.url&&response.url!==target.href)throw error('REDIRECT');
   const declared=Number(response.headers.get('content-length')??'0');
   if(!Number.isFinite(declared)||declared<0||declared>MAX_BYTES)throw error('RESPONSE_SIZE');
   const type=(response.headers.get('content-type')??'').split(';')[0]!.trim().toLowerCase();
   if(pdf?!['application/pdf','application/octet-stream'].includes(type):type&&!['text/html','application/xhtml+xml'].includes(type))throw error('RESPONSE_TYPE');
   if(!response.body)throw error('RESPONSE_EMPTY');
   const reader=response.body.getReader(),parts:Uint8Array[]=[];let bytes=0;
   const cancelReader=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancelReader,{once:true});
   try{while(true){check();const part=await reader.read();check();if(part.done)break;bytes+=part.value.byteLength;if(bytes>MAX_BYTES)throw error('RESPONSE_SIZE');parts.push(part.value);}}
   finally{controller.signal.removeEventListener('abort',cancelReader);await reader.cancel().catch(()=>{});reader.releaseLock();}
   return{bytes:Buffer.concat(parts),url:target.href,fetchedAt:new Date().toISOString()};
  };
  return await Promise.race([operation(),aborted]);
 }catch(e){if(options.signal?.aborted||controller.signal.aborted)check();if(e instanceof Error&&e.message.startsWith('OFFICIAL_'))throw e;throw error('HTTP_FAILED');}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',onAbort);controller.signal.removeEventListener('abort',abortHandler);if(response?.body&&!response.body.locked)void response.body.cancel().catch(()=>{});}
}

function pinnedRequest(url:URL,address:{address:string;family:number},signal:AbortSignal,accept:string):Promise<Response>{
 return new Promise((resolve,reject)=>{
  const request=httpsRequest(url,{method:'GET',signal,headers:{accept,'accept-encoding':'identity'},lookup:(_host,opts,cb)=>{if(opts.all)cb(null,[address]);else cb(null,address.address,address.family);}},incoming=>{
   if(incoming.headers['content-encoding']&&incoming.headers['content-encoding']!=='identity'){incoming.destroy();reject(error('RESPONSE_ENCODING'));return;}
   const headers=new Headers();for(const [k,v] of Object.entries(incoming.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(', '):v);
   // A web stream keeps the decoded-body bound in one reader implementation.
   const status=incoming.statusCode??500;
   try{resolve(new Response([204,205,304].includes(status)?null:Readable.toWeb(incoming) as ReadableStream<Uint8Array>,{status,headers}));if([204,205,304].includes(status))incoming.resume();}catch(e){incoming.destroy();reject(e);}
  });request.on('error',reject);request.end();
 });
}
