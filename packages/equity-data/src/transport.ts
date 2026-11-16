import { join } from 'node:path';
import { redact } from '../../chain-data/src/output.js';
import type { EquityConfig } from './config.js';
import { DailyQuota } from './quota.js';
import { TwelveDataQuota } from './twelve-quota.js';
import { MARKET_SYMBOLS } from './types.js';
import { previousNewYorkDate } from './twelve-data.js';

export class EquityDataError extends Error {
  constructor(readonly code:string,readonly status?:number){super(code);this.name='EquityDataError';}
}
export function safeEquityCode(error:unknown):string {
  if(error instanceof EquityDataError)return error.code;
  if(error instanceof Error&&/^QUOTA_(EXHAUSTED|STORAGE|LIMIT)$/.test(error.message))return error.message;
  return 'DATA_UNAVAILABLE';
}
export function equitySymbol(symbol:string):string {
  const s=symbol.toUpperCase();
  if(!/^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,2})?$/.test(s))throw new EquityDataError('INVALID_SYMBOL');
  return s;
}
type Options={fetch?:typeof fetch;beforeRequest?:()=>void|Promise<void>;record?:(record:unknown)=>Promise<void>;signal?:AbortSignal;quota?:DailyQuota;twelveQuota?:TwelveDataQuota};
let secNextStart=0;
let secDispatch:Promise<void>=Promise.resolve();
function filingPath(cik:string,accession:unknown,document:unknown):string|undefined {
  if(typeof accession!=='string'||!/^\d{10}-\d{2}-\d{6}$/.test(accession)||typeof document!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.(?:htm|html|txt)$/i.test(document)||document.includes('..'))return;
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-','')}/${document}`;
}
export class EquityTransport {
  private attempts=0;
  private readonly started=Date.now();
  private halted?:string;
  private quota?:DailyQuota;
  private ownsQuota=false;
  private twelveQuota?:TwelveDataQuota;
  private ownsTwelveQuota=false;
  private localRemaining?:number;
  private readonly verifiedFilings=new Set<string>();
  private readonly verifiedPrimaryFilings=new Set<string>();
  constructor(private readonly config:EquityConfig,private readonly options:Options={}) {this.quota=options.quota;this.twelveQuota=options.twelveQuota;}
  get requestCount():number{return this.attempts;}
  close():void {if(this.ownsQuota){this.quota?.close();this.quota=undefined;this.ownsQuota=false;}if(this.ownsTwelveQuota){this.twelveQuota?.close();this.twelveQuota=undefined;this.ownsTwelveQuota=false;}}
  async withAttemptBudget<T>(limit:number,fn:()=>Promise<T>):Promise<T> {
    if(this.localRemaining!==undefined)throw new EquityDataError('OPERATION_IN_PROGRESS');
    this.localRemaining=limit;
    try{return await fn();}finally{this.localRemaining=undefined;}
  }
  async request(provider:'fmp'|'sec'|'twelve-data',endpoint:string,symbol?:string):Promise<unknown> {
    let url:string;
    if(provider==='fmp') {
      if(!['profile','historical-price-eod/light'].includes(endpoint))throw new EquityDataError('INVALID_ENDPOINT');
      if(!this.config.fmpKey)throw new EquityDataError('MISSING_FMP_API_KEY');
      const s=equitySymbol(symbol??'');
      url=`https://financialmodelingprep.com/stable/${endpoint}?${new URLSearchParams({symbol:s,apikey:this.config.fmpKey})}`;
    } else if(provider==='twelve-data') {
      if(endpoint!=='time_series')throw new EquityDataError('INVALID_ENDPOINT');
      if(!this.config.twelveDataKey)throw new EquityDataError('MISSING_TWELVE_DATA_API_KEY');
      const s=equitySymbol(symbol??'');if(!(MARKET_SYMBOLS as readonly string[]).includes(s))throw new EquityDataError('INVALID_MARKET_SYMBOL');
      url=`https://api.twelvedata.com/time_series?${new URLSearchParams({symbol:s,interval:'1day',country:'United States',type:'ETF',outputsize:'128',format:'JSON',order:'asc',adjust:'splits',end_date:previousNewYorkDate()})}`;
    } else if(provider==='sec') {
      if(endpoint==='tickers')url='https://www.sec.gov/files/company_tickers_exchange.json';
      else if(/^(?:submissions|api\/xbrl\/companyfacts)\/CIK\d{10}\.json$/.test(endpoint))url=`https://data.sec.gov/${endpoint}`;
      else throw new EquityDataError('INVALID_ENDPOINT');
    } else throw new EquityDataError('INVALID_PROVIDER');
    const body=await this.perform(provider,endpoint,url,symbol,false);
    if(provider==='sec'&&endpoint.startsWith('submissions/'))this.captureFilings(body,endpoint.slice(15,25));
    return body;
  }
  async filing(url:string):Promise<string> {
    if(!/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d{1,10}\/\d{18}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.(?:htm|html|txt)$/i.test(url)||url.includes('..'))throw new EquityDataError('INVALID_FILING');
    if(!this.verifiedFilings.has(url))throw new EquityDataError('FILING_NOT_VERIFIED');
    return await this.perform('sec','filing',url,undefined,true) as string;
  }
  /** Only a submissions-verified primary can authorize its own accession directory. */
  async filingIndex(primaryUrl:string):Promise<unknown> {
    if(!/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d{1,10}\/\d{18}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.(?:htm|html|txt)$/i.test(primaryUrl)||primaryUrl.includes('..'))throw new EquityDataError('INVALID_FILING_INDEX');
    if(!this.verifiedPrimaryFilings.has(primaryUrl))throw new EquityDataError('FILING_INDEX_NOT_VERIFIED');
    const directoryUrl=primaryUrl.slice(0,primaryUrl.lastIndexOf('/'));
    const body=await this.perform('sec','filing-index',`${directoryUrl}/index.json`,undefined,false);
    const directory=(body as {directory?:{name?:unknown;item?:unknown}}|null)?.directory;
    if(directory?.name!==new URL(directoryUrl).pathname||!Array.isArray(directory.item)||directory.item.length>10000)throw new EquityDataError('INVALID_FILING_INDEX');
    for(const item of directory.item){
      const name=item&&typeof item==='object'?(item as {name?:unknown}).name:undefined;
      if(typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.(?:htm|html|txt)$/i.test(name)&&!name.includes('..'))this.verifiedFilings.add(`${directoryUrl}/${name}`);
    }
    return body;
  }
  private captureFilings(body:unknown,cik:string) {
    const b=body as {cik?:unknown;filings?:{recent?:{accessionNumber?:unknown[];primaryDocument?:unknown[]}}};
    if(!b||String(b.cik).padStart(10,'0')!==cik)return;
    const r=b.filings?.recent;
    if(!Array.isArray(r?.accessionNumber)||!Array.isArray(r.primaryDocument))return;
    r.accessionNumber.slice(0,1000).forEach((a,i)=>{const url=filingPath(cik,a,r.primaryDocument![i]);if(url){this.verifiedFilings.add(url);this.verifiedPrimaryFilings.add(url);}});
  }
  private check():void {
    if(this.options.signal?.aborted)throw new EquityDataError('CANCELLED');
    if(this.halted)throw new EquityDataError(this.halted);
    if(Date.now()-this.started>=300000)throw new EquityDataError('STAGE_DEADLINE');
    if(this.attempts>=32)throw new EquityDataError('HTTP_BUDGET');
    if(this.localRemaining!==undefined&&this.localRemaining<=0)throw new EquityDataError('OPERATION_HTTP_BUDGET');
  }
  private async perform(provider:'fmp'|'sec'|'twelve-data',endpoint:string,url:string,symbol:string|undefined,text:boolean):Promise<unknown> {
    if(provider==='sec'&&!this.config.secUserAgent)throw new EquityDataError('MISSING_SEC_USER_AGENT');
    for(let retry=0;;retry++) {
      this.check();
      const deadline=Math.min(this.config.timeoutMs,300000-(Date.now()-this.started));
      const controller=new AbortController();
      const onAbort=()=>controller.abort();this.options.signal?.addEventListener('abort',onAbort,{once:true});
      let timer:ReturnType<typeof setTimeout>|undefined;
      let error:EquityDataError|undefined;
      try {
        const operation=async()=> {
          this.check();
          try{await this.options.beforeRequest?.();}catch{this.halted='REQUEST_REJECTED';throw new EquityDataError('REQUEST_REJECTED');}
          if(provider==='sec') {
            const ready=secDispatch.catch(()=>{}).then(async()=>{
              await this.pause(Math.max(0,secNextStart-Date.now()),controller.signal);
              if(controller.signal.aborted)throw new EquityDataError(this.options.signal?.aborted?'CANCELLED':'REQUEST_TIMEOUT');
              secNextStart=Date.now()+500;
            });
            secDispatch=ready;await ready;
          }
          this.check();
          if(controller.signal.aborted)throw new EquityDataError(this.options.signal?.aborted?'CANCELLED':'REQUEST_TIMEOUT');
          if(provider==='twelve-data'){
            if(!this.twelveQuota){this.twelveQuota=new TwelveDataQuota(join(this.config.outputDirectory,'twelve-data-quota.sqlite'),this.config.twelveDataDailyLimit??600);this.ownsTwelveQuota=true;}
            for(;;){
              this.check();if(controller.signal.aborted)throw new EquityDataError(this.options.signal?.aborted?'CANCELLED':'REQUEST_TIMEOUT');
              const delay=this.twelveQuota.reserve();if(!delay)break;
              await this.pause(delay,controller.signal);
            }
          }
          if(provider==='fmp') {
            if(!this.quota){this.quota=new DailyQuota(join(this.config.outputDirectory,'equity-quota.sqlite'),this.config.dailyLimit);this.ownsQuota=true;}
            this.quota.reserve();
          }
          this.attempts++;if(this.localRemaining!==undefined)this.localRemaining--;
          const response=await (this.options.fetch??fetch)(url,{signal:controller.signal,redirect:'error',headers:provider==='sec'?{'User-Agent':this.config.secUserAgent,Accept:text?'text/html,text/plain':'application/json'}:provider==='twelve-data'?{Accept:'application/json',Authorization:`apikey ${this.config.twelveDataKey}`}:{Accept:'application/json'}});
          if(response.status===429){this.halted='RATE_LIMIT';throw new EquityDataError('RATE_LIMIT',429);}
          if(!response.ok)throw new EquityDataError([401,402,403].includes(response.status)?'PERMISSION_DENIED':response.status>=500?'UPSTREAM_FAILURE':'HTTP_ERROR',response.status);
          const maximum=endpoint.startsWith('api/xbrl/companyfacts/')?32*1024*1024:provider==='sec'&&endpoint==='filing'?16*1024*1024:2*1024*1024;
          if(Number(response.headers.get('content-length'))>maximum) {await response.body?.cancel();throw new EquityDataError('RESPONSE_SIZE');}
          const reader=response.body?.getReader(); const chunks:Uint8Array[]=[];let size=0;
          if(reader)try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximum)throw new EquityDataError('RESPONSE_SIZE');chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
          const raw=Buffer.concat(chunks).toString('utf8');
          let body:unknown=raw;
          if(!text)try{body=JSON.parse(raw);}catch{throw new EquityDataError('INVALID_JSON');}
          if(!text) {
            if(provider==='twelve-data'&&body&&typeof body==='object'&&(body as {status?:string}).status==='error'){
              const code=Number((body as {code?:number}).code);
              if(code===429){this.halted='RATE_LIMIT';throw new EquityDataError('RATE_LIMIT',429);}
              throw new EquityDataError([401,402,403].includes(code)?'PERMISSION_DENIED':code>=500?'UPSTREAM_FAILURE':'PROVIDER_ERROR',code);
            }
            const errorText=typeof body==='string'?body:body&&typeof body==='object'&&!Array.isArray(body)?Object.entries(body).filter(([k])=>/error|message|information|note/i.test(k)).map(([,v])=>String(v)).join(' '):'';
            if(/limit reach|rate limit|too many requests|quota|daily.*limit/i.test(errorText)){this.halted='RATE_LIMIT';throw new EquityDataError('RATE_LIMIT',429);}
            if(/premium|subscription|upgrade|not available.*plan|restricted|invalid.*key|apikey|api key/i.test(errorText))throw new EquityDataError('PERMISSION_DENIED',403);
            if(errorText)throw new EquityDataError('PROVIDER_ERROR');
          }
          if(controller.signal.aborted)throw new EquityDataError(this.options.signal?.aborted?'CANCELLED':'REQUEST_TIMEOUT');
          await this.record({provider,endpoint,symbol,...(provider==='twelve-data'?{parameters:Object.fromEntries(new URL(url).searchParams)}:{}),...(provider==='sec'?{source:url}:{}),status:response.status,fetchedAt:new Date().toISOString(),body});
          return body;
        };
        const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new EquityDataError(this.options.signal?.aborted?'CANCELLED':'REQUEST_TIMEOUT'));},deadline);});
        const aborted=new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new EquityDataError(this.options.signal?.aborted?'CANCELLED':'REQUEST_TIMEOUT')),{once:true});});
        return await Promise.race([operation(),timeout,aborted]);
      } catch(caught) {
        if(caught instanceof EquityDataError)error=caught;
        else if(this.options.signal?.aborted)error=new EquityDataError('CANCELLED');
        else if(caught instanceof Error&&/^QUOTA_/.test(caught.message))error=new EquityDataError(safeEquityCode(caught));
        else error=new EquityDataError('NETWORK_ERROR');
      } finally {if(timer)clearTimeout(timer);this.options.signal?.removeEventListener('abort',onAbort);}
      if(error.code==='RECORD_FAILED')throw error;
      await this.record({provider,endpoint,symbol,status:error.status??null,code:error.code,fetchedAt:new Date().toISOString()});
      if(!['NETWORK_ERROR','REQUEST_TIMEOUT','UPSTREAM_FAILURE'].includes(error.code)||retry>=this.config.maxRetries)throw error;
      await this.pause(Math.min(250*2**retry,2000),this.options.signal);
    }
  }
  private async record(value:unknown):Promise<void> {
    try{await this.options.record?.(redact(value,[this.config.fmpKey,this.config.secUserAgent,this.config.twelveDataKey??'']));}
    catch{this.halted='RECORD_FAILED';throw new EquityDataError('RECORD_FAILED');}
  }
  private async pause(ms:number,signal?:AbortSignal):Promise<void> {
    if(signal?.aborted)throw new EquityDataError('CANCELLED');
    if(ms<=0)return;
    await new Promise<void>((resolve,reject)=>{const onAbort=()=>{clearTimeout(timer);reject(new EquityDataError('CANCELLED'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},ms);signal?.addEventListener('abort',onAbort,{once:true});});
  }
}
