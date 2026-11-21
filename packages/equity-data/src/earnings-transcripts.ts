import type {Filing,Financials} from './types.js';
import type {OfficialSource} from './discovery-types.js';

/** Only matching-period SEC facts from the actual filing establish the vendor's fiscal label. */
export function transcriptQuarters(filings:Filing[],financials:Financials):string[]{
  const periods=new Set<string>();
  const reports=filings.filter(f=>f.form==='10-Q'||f.form==='10-K')
    .sort((a,b)=>(b.reportDate??b.filed).localeCompare(a.reportDate??a.filed));
  for(const filing of reports){
    const annual=filing.form==='10-K';
    const labels=new Set<string>();
    for(const point of annual?financials.annual:financials.quarterly){
      if(point.accession!==filing.accession||point.form!==filing.form)continue;
      if(filing.reportDate){if(point.end!==filing.reportDate)continue;}
      else{
        const lag=Date.parse(filing.filed)-Date.parse(point.end);
        if(!Number.isFinite(lag)||lag<0||lag>120*86400000)continue;
      }
      const quarter=annual&&point.fiscalPeriod==='FY'?'Q4':point.fiscalPeriod;
      const label=`${point.fiscalYear??''}${quarter??''}`;
      if(/^20\d{2}Q[1-4]$/.test(label))labels.add(label);
    }
    if(labels.size===1)periods.add([...labels][0]!);
    if(periods.size===2)break;
  }
  return [...periods];
}

export function alphaTranscriptUrl(symbol:string,quarter:string):string{
  return `https://www.alphavantage.co/query?${new URLSearchParams({function:'EARNINGS_CALL_TRANSCRIPT',symbol,quarter})}`;
}

export function textAsDocumentHtml(lines:string[]):string{
  return lines.map(line=>`<p>${line.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}</p>`).join('');
}

export function alphaTranscriptLines(value:unknown,symbol:string,quarter:string):string[]{
  const body=value as {symbol?:unknown;quarter?:unknown;transcript?:unknown}|null;
  if(body?.symbol!==symbol||body.quarter!==quarter||!Array.isArray(body.transcript)||body.transcript.length>2000)throw Error('INVALID_TRANSCRIPT_RESPONSE');
  if(!body.transcript.length)throw Error('NO_TRANSCRIPT_AVAILABLE');
  return body.transcript.flatMap((turn:unknown)=>{
    const entry=turn as {speaker?:unknown;title?:unknown;content?:unknown}|null;
    if(typeof entry?.speaker!=='string'||!entry.speaker.trim()||typeof entry.content!=='string'||!entry.content.trim())throw Error('INVALID_TRANSCRIPT_RESPONSE');
    const label=typeof entry.title==='string'&&entry.title.trim()?`${entry.speaker} (${entry.title})`:entry.speaker;
    return [label,entry.content];
  });
}

const salesforceTranscriptBase='https://s205.q4cdn.com/626266368/files/doc_financials/';

/** These exact issuer archive links were verified against Salesforce's investor materials. */
export const salesforceTranscriptSources:readonly OfficialSource[]=[2,1].map(quarter=>{
  const url=`${salesforceTranscriptBase}2027/q${quarter}/Salesforce-Q${quarter}-FY27-Earnings-Transcript.pdf`;
  return {id:`salesforce-fy2027-q${quarter}-transcript`,kind:'pdf',url,allowedHosts:['s205.q4cdn.com'],pathPrefix:new URL(url).pathname,verification:'pending'};
});

export function salesforceTranscriptPeriod(url:string,cik:string):string|undefined{
  if(cik!=='0001108524'||!salesforceTranscriptSources.some(source=>source.url===url))return;
  const match=/\/(20\d{2})\/q([1-4])\//.exec(url);
  return match?`${match[1]}Q${match[2]}`:undefined;
}
