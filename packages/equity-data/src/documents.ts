import {createHash} from 'node:crypto';
import {parseDocument} from 'htmlparser2';
import type {DiscoveryDocument,DocumentSection,SectionKind,EvidenceChunk} from './discovery-types.js';

type AnyNode=ReturnType<typeof parseDocument>['children'][number];
type DocumentInput=Pick<DiscoveryDocument,'id'|'symbol'|'cik'|'sourceKind'|'url'>&Partial<Pick<DiscoveryDocument,'title'|'form'|'accession'|'period'|'publishedAt'|'fetchedAt'>>&{html:string};
const MAX_HTML=2*1024*1024,MAX_TEXT=500000,CHUNK_SIZE=1800;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const blocks=new Set(['address','article','aside','blockquote','br','caption','dd','div','dl','dt','h1','h2','h3','h4','h5','h6','hr','li','main','ol','p','pre','section','table','td','th','tr','ul']);
const skipped=new Set(['script','style','noscript','template','nav','header','footer','head','svg','canvas','iframe','object','ix:hidden']);

/** Parse inert HTML only. Offsets refer to the canonical, bounded `text`, never HTML byte offsets. */
export function buildDocument(input:DocumentInput):DiscoveryDocument {
 if(Buffer.byteLength(input.html,'utf8')>MAX_HTML)throw Error('DOCUMENT_RESPONSE_SIZE');
 const dom=parseDocument(input.html,{decodeEntities:true});
 const lines:{text:string;linked:number}[]=[];
 let line='',linked=0,title='';
 const flush=()=>{const text=line.replace(/\s+/gu,' ').trim();if(text)lines.push({text,linked});line='';linked=0;};
 const stack:{node:AnyNode;exit?:boolean;link?:boolean;title?:boolean}[]=dom.children.slice().reverse().map(node=>({node}));
 while(stack.length){
  const entry=stack.pop()!,n=entry.node;
  if(n.type==='text'){
   if(entry.title)title+=n.data;
   else{line+=n.data;if(entry.link)linked+=n.data.trim().length;}
   continue;
  }
  if(!('name' in n)||!('children' in n))continue;
  const tag=n.name.toLowerCase(),attrs=n.attribs;
  if(entry.exit){if(blocks.has(tag))flush();continue;}
  // Titles are metadata. All other head content is omitted.
  if(tag==='head'){
   const find=[...n.children];while(find.length){const child=find.pop()!;if('name'in child&&child.name==='title')stack.push({node:child,title:true});else if('children'in child)find.push(...child.children);}
   continue;
  }
  if(skipped.has(tag)||attrs.hidden!==undefined||attrs['aria-hidden']==='true'||/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs.style??'')||/(?:^|[-_\s])(?:toc|table-of-contents)(?:$|[-_\s])/i.test(`${attrs.id??''} ${attrs.class??''}`))continue;
  if(blocks.has(tag)&&!entry.title)flush();
  stack.push({...entry,exit:true});
  for(let i=n.children.length-1;i>=0;i--)stack.push({node:n.children[i]!,link:entry.link||tag==='a',title:entry.title||tag==='title'});
 }
 flush();
 let text=lines.map(l=>l.text).join('\n');
 const warnings:string[]=[];
 if(text.length>MAX_TEXT){text=text.slice(0,MAX_TEXT);warnings.push('Indexed text truncated at 500000 characters; the remaining document was not indexed.');}
 const candidates:{start:number;title:string;kind:SectionKind;lineIndex:number}[]=[];
 let position=0;
 for(let lineIndex=0;lineIndex<lines.length;lineIndex++){
  const l=lines[lineIndex]!;
  if(position>=text.length)break;
  const kind=headingKind(l.text);
  if(kind!==undefined&&l.linked<l.text.length*.35)candidates.push({start:position,title:l.text,kind,lineIndex});
  position+=l.text.length+1;
 }
 const accepted=candidates.filter((h,i)=>{
  if(/^(?:\d{1,4}|[ivxlcdm]{1,8})$/i.test(lines[h.lineIndex+1]?.text??''))return false;
  const body=text.slice(h.start+h.title.length,candidates[i+1]?.start??text.length).trim();
  // TOC titles followed only by page numbers/other titles are insufficient evidence.
  return body.replace(/[\d\s.]/g,'').length>=80;
 });
 const sections:DocumentSection[]=[];
 if(!accepted.length){
  warnings.push('Reliable body sections could not be located; excerpts are fallback text positions, not complete chapters.');
  if(text)sections.push({id:`${input.id}:s0`,title:'Unstructured text excerpts',kind:'other',start:0,end:text.length,confidence:'fallback'});
 }else{
  if(accepted[0]!.start>0)sections.push({id:`${input.id}:s0`,title:'Unclassified opening text',kind:'other',start:0,end:accepted[0]!.start,confidence:'fallback'});
  accepted.forEach((h,i)=>sections.push({id:`${input.id}:s${sections.length}`,title:h.title,kind:h.kind,start:h.start,end:accepted[i+1]?.start??text.length,confidence:'heading'}));
 }
 const chunks:EvidenceChunk[]=[];
 for(const section of sections){
  let start=section.start;
  while(start<section.end){
   while(start<section.end&&/\s/u.test(text[start]!))start++;
   if(start>=section.end)break;
   let end=Math.min(section.end,start+CHUNK_SIZE);
   if(end<section.end){const cut=Math.max(text.lastIndexOf('\n',end),text.lastIndexOf(' ',end));if(cut>start+CHUNK_SIZE/2)end=cut;}
   while(end>start&&/\s/u.test(text[end-1]!))end--;
   const chunkText=text.slice(start,end);
   chunks.push({id:`${input.id}:c${chunks.length}`,documentId:input.id,symbol:input.symbol,cik:input.cik,sectionId:section.id,kind:section.kind,text:chunkText,start,end,hash:hash(chunkText)});
   start=end;
  }
 }
 return {id:input.id,symbol:input.symbol,cik:input.cik,sourceKind:input.sourceKind,url:input.url,title:input.title??title.trim(),...(input.form?{form:input.form}:{}),...(input.accession?{accession:input.accession}:{}),...(input.period?{period:input.period}:{}),...(input.publishedAt?{publishedAt:input.publishedAt}:{}),fetchedAt:input.fetchedAt??new Date().toISOString(),hash:hash(text),text,sections,chunks,warnings};
}

function headingKind(title:string):SectionKind|undefined {
 if(title.length>220)return;
 const s=title.toLowerCase().replace(/[’‘]/g,"'").replace(/\s+/g,' ').replace(/[.:—–-]+$/g,'').trim();
 if(/^(?:item\s*1[. :—–-]+)?business(?: overview)?$/.test(s))return'business';
 if(/^(?:item\s*1a[. :—–-]+)?risk factors$/.test(s))return'risk';
 if(/^(?:item\s*[27][. :—–-]+)?management(?:'s)? discussion(?: and analysis)?(?: of financial condition and results of operations)?$/.test(s))return'mda';
 if(/^(?:item\s*[18][. :—–-]+)?(?:financial statements(?: and supplementary data)?|notes to (?:the )?(?:consolidated )?financial statements)$/.test(s))return'financial';
 if(/^item\s*\d+[a-z]?[. :—–-]+\S/.test(s))return'other';
}

/** Local lexical relevance only; an empty/no-match query returns document-order excerpts. */
export function retrieveChunks(document:DiscoveryDocument,query:string,options:{offset?:number;limit?:number}={}):{chunks:EvidenceChunk[];total:number;nextOffset:number|null}{
 const offset=options.offset??0,limit=options.limit??6;
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>20)throw Error('INVALID_PAGINATION');
 const terms=[...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)??[])].slice(0,40);
 const scored=document.chunks.map((chunk,index)=>({chunk,index,score:terms.reduce((sum,term)=>sum+(chunk.text.toLowerCase().includes(term)?1:0),0)}));
 const matches=scored.filter(x=>x.score>0);
 const ordered=matches.length?matches.sort((a,b)=>b.score-a.score||a.index-b.index):scored;
 const total=ordered.length;
 return{chunks:ordered.slice(offset,offset+limit).map(x=>x.chunk),total,nextOffset:offset+limit<total?offset+limit:null};
}
