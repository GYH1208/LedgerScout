import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export const equityProjectRoot = fileURLToPath(new URL('../../../', import.meta.url));
export type EquityConfig = { fmpKey:string; twelveDataKey?:string; twelveDataDailyLimit?:number; alphaVantageKey?:string; secUserAgent:string; timeoutMs:number; maxRetries:number; dailyLimit:number; outputDirectory:string };
export function loadEquityConfig(env:Record<string,string|undefined> = process.env, files:string[] = [resolve(equityProjectRoot,'.env')]):EquityConfig {
  let merged:Record<string,string|undefined> = {};
  for(const file of files) {
    try { merged = {...merged,...parseEnv(readFileSync(file,'utf8'))}; }
    catch(error) { if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('EQUITY_CONFIG_FILE'); }
  }
  merged = {...merged,...Object.fromEntries(Object.entries(env).filter(([,v])=>v!==undefined))};
  const integer=(name:string,fallback:number,min:number,max:number) => {
    const raw=merged[name]??String(fallback), n=Number(raw);
    if(!/^\d+$/.test(raw)||!Number.isSafeInteger(n)||n<min||n>max) throw new Error(`EQUITY_CONFIG_${name}`);
    return n;
  };
  const twelveDataKey=merged.TWELVE_DATA_API_KEY?.trim()??'';
  if(twelveDataKey&&(/[\s\x00-\x1f]/.test(twelveDataKey)||/^(YOUR_|replace|insert|paste|<)/i.test(twelveDataKey)))throw new Error('EQUITY_CONFIG_TWELVE_DATA_API_KEY');
  const fmpKey=merged.FMP_API_KEY?.trim()??'',secUserAgent=merged.SEC_USER_AGENT?.trim()??'';
  if(fmpKey&&(/[\s\x00-\x1f]/.test(fmpKey)||/^(YOUR_|replace|insert|paste|<)/i.test(fmpKey)))throw new Error('EQUITY_CONFIG_FMP_API_KEY');
  if(secUserAgent&&(!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(secUserAgent)||/[\r\n\x00-\x1f]/.test(secUserAgent)||/example\.(com|org|net)|your[_ -]?email|placeholder/i.test(secUserAgent)))throw new Error('EQUITY_CONFIG_SEC_USER_AGENT');
  const alphaVantageKey=merged.ALPHA_VANTAGE_API_KEY?.trim();
  return {fmpKey,twelveDataKey,twelveDataDailyLimit:integer('TWELVE_DATA_DAILY_LIMIT',600,1,800),...(alphaVantageKey?{alphaVantageKey}:{}),secUserAgent,timeoutMs:integer('REQUEST_TIMEOUT_MS',15000,1,120000),maxRetries:integer('MAX_RETRIES',2,0,5),dailyLimit:integer('FMP_DAILY_LIMIT',200,1,200),outputDirectory:resolve(merged.EQUITY_OUTPUT_DIRECTORY??resolve(equityProjectRoot,'runtime-results'))};
}
export function configurationStatus(config:EquityConfig) {
  return {market:config.twelveDataKey?'configured-unverified':'missing-TWELVE_DATA_API_KEY',fmp:config.fmpKey?'configured-unverified':'missing-FMP_API_KEY',sec:config.secUserAgent?'configured-unverified':'missing-SEC_USER_AGENT',dailyLimit:config.dailyLimit,twelveDataDailyLimit:config.twelveDataDailyLimit??600};
}
