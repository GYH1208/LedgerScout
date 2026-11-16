import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { Results,redact } from '../../chain-data/src/output.js';
import { loadEquityConfig, configurationStatus } from './config.js';
import { parseCapabilityArgs, inspectCapability, assessCoverage, type Capability } from './capabilities.js';
import { DailyQuota } from './quota.js';
import { EquityTransport, EquityDataError, safeEquityCode } from './transport.js';
import { EquityProvider } from './provider.js';
import { normalizeTwelvePrices } from './twelve-data.js';
import { buildMarketSnapshot } from './metrics.js';
import type { PriceSeries } from './types.js';

export async function runCapabilityCli(args=process.argv.slice(2)):Promise<void> {
  const selected=parseCapabilityArgs(args),config=loadEquityConfig();
  if(selected.config){console.log(JSON.stringify(configurationStatus(config),null,2));return;}
  const results=new Results(join(config.outputDirectory,'equity','capabilities'),[config.fmpKey,config.secUserAgent,config.twelveDataKey??'']);
  const quota=new DailyQuota(join(config.outputDirectory,'equity-quota.sqlite'),config.dailyLimit);
  const controller=new AbortController();const onInterrupt=()=>controller.abort();process.once('SIGINT',onInterrupt);
  const series:PriceSeries[]=[];const rows:Capability[]=[];let halted:string|undefined;
  const transport=new EquityTransport(config,{quota,signal:controller.signal,record:async record=>{
    await results.save('provider-response',record);
    if(selected.stage==='stocks'){
      const r=record as {endpoint:string;symbol?:string;body?:unknown;code?:string;status?:number};
      if(r.symbol)rows.push(inspectCapability(r.endpoint,r.symbol,r.body,r.code?new EquityDataError(r.code,r.status):undefined));
    }
  }});
  const provider=new EquityProvider(transport);
  try {
    for(const symbol of selected.symbols) {
      if(selected.stage==='stocks') {
        if(halted){rows.push(inspectCapability('company',symbol,undefined,new EquityDataError(halted)));continue;}
        try{
          await provider.getCompany(symbol);
          for(const r of rows)if(r.symbol===symbol)r.identityVerified=true;
        }catch(error){
          const code=safeEquityCode(error);rows.push(inspectCapability('company',symbol,undefined,error));
          if(['RATE_LIMIT','QUOTA_EXHAUSTED','QUOTA_STORAGE','RECORD_FAILED','HTTP_BUDGET','STAGE_DEADLINE','CANCELLED'].includes(code))halted=code;
        }
        continue;
      }
      const endpoint='time_series';
      if(halted){rows.push(inspectCapability(endpoint,symbol,undefined,new EquityDataError(halted)));continue;}
      try{
        const body=await transport.request('twelve-data',endpoint,symbol);
        const row=inspectCapability(endpoint,symbol,body);rows.push(row);
        if(row.status==='available')series.push(normalizeTwelvePrices(body,symbol));
      }catch(error){
        rows.push(inspectCapability(endpoint,symbol,undefined,error));const code=safeEquityCode(error);
        if(['RATE_LIMIT','QUOTA_EXHAUSTED','QUOTA_STORAGE','RECORD_FAILED','HTTP_BUDGET','STAGE_DEADLINE','CANCELLED'].includes(code))halted=code;
      }
    }
    const report={stage:selected.stage,symbols:selected.symbols,fetchedAt:new Date().toISOString(),httpAttempts:transport.requestCount,rows,coverage:assessCoverage(rows),...(selected.stage==='market'?{provider:'twelve-data',market:buildMarketSnapshot(series)}:{}),status:halted?'stopped':'capability-check-only'};
    const reportPath=await results.save('capability-report',report);
    console.log(JSON.stringify(redact({...report,reportPath},[config.fmpKey,config.secUserAgent,config.twelveDataKey??'']),null,2));
  } finally{transport.close();quota.close();process.removeListener('SIGINT',onInterrupt);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runCapabilityCli().catch(error=>{console.error(safeEquityCode(error));process.exitCode=1;});
