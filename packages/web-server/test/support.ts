import { once } from 'node:events';
import { runAgent, type RequestModel } from '@ledgerscout/agent-runtime';
import { parseConfig } from '@ledgerscout/chain-data';
import { createWebServer } from '../src/server.js';

export const address = '0x'+'1'.repeat(40);
export const question = `查询 ${address} 当前 ETH 余额`;
export const contract = '0x'+'2'.repeat(40);
export const tokenQuestion = `查询 ${address} 的代币余额，合约 ${contract}`;
export const headers = { 'content-type': 'application/json', 'x-ledgerscout-client': 'web', origin: 'http://127.0.0.1:4173' };
export const cfg = (dir: string) => ({ key: 'offline-model-secret', model: 'deepseek-flash', chain: parseConfig({ ALCHEMY_API_KEY: 'offline-chain', ETHERSCAN_API_KEY: 'offline-scan', REQUEST_INTERVAL_MS: '0', MAX_RETRIES: '0' }), outputDirectory: dir });
export function offlineRun(extra: { onFetch?: () => void; onModel?: () => Promise<void>; cancelAfterQuery?: boolean; token?: boolean; metadataError?: boolean } = {}) {
  return async (o: Parameters<typeof runAgent>[0]) => {
    const ctl = new AbortController();
    const request: RequestModel = async r => {
      await extra.onModel?.();
      const current = [...r.messages].reverse().find(m=>m.role==='user')?.content ?? '';
      const historical = current.match(/q_[A-Za-z0-9_-]+/)?.[0] ?? (/previous/i.test(current)
        ? r.messages.find(m=>m.content.startsWith('可用历史证据索引'))?.content.match(/q_[A-Za-z0-9_-]+/)?.[0] : undefined);
      const tool = [...r.messages].reverse().find(m=>m.role==='tool');
      const queryId = historical ?? (tool ? JSON.parse(tool.content).queryId : undefined);
      return queryId ? { content: JSON.stringify({kind:'answer',queryIds:[queryId],claims:[{queryId,field:extra.token?'token_balance':'eth'}]}),usage:{inputTokens:10,outputTokens:3,totalTokens:13} }
        : { content:'',toolCalls:[{id:'balance',name:extra.token?'get_erc20_balance':'get_eth_balance',arguments:{address,...(extra.token?{contractAddress:contract}:{})}}],usage:{inputTokens:10,outputTokens:3,totalTokens:13} };
    };
    return runAgent({ ...o, request, signal: AbortSignal.any([o.signal ?? new AbortController().signal,ctl.signal]),
      onEvent:e=>{o.onEvent?.(e);if(extra.cancelAfterQuery&&e.type==='tool_finished')ctl.abort();},
      fetch:async(_url,init)=>{
        extra.onFetch?.(); const b=JSON.parse(String(init?.body));
        if(extra.token&&b.params[0]?.data==='0x313ce567'&&extra.metadataError)return Response.json({jsonrpc:'2.0',id:b.id,error:{code:3,message:'execution reverted'}});
        const result=b.method==='eth_chainId'?'0x1':b.method==='eth_blockNumber'?'0xa':extra.token?'0x'+(b.params[0]?.data==='0x313ce567'?'6':'20000000000001').padStart(64,'0'):'0xde0b6b3a7640001';
        return Response.json({jsonrpc:'2.0',id:b.id,result});
      } });
  };
}
export async function start(dir: string, run = offlineRun()) {
  const server = createWebServer({config:()=>cfg(dir),run});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  await (server as any).ready;
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return {server,base,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await (server as any).shutdown;}};
}
export const post = (base:string,path:string,body:unknown={})=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
export async function state(base:string) {const r=await fetch(base+'/api/state');return {status:r.status,body:await r.json() as any};}
export async function done(base:string) {for(let i=0;i<200;i++){const s=await state(base);if(!s.body.busy)return s.body;await new Promise(r=>setTimeout(r,10));}throw Error('task did not complete');}
