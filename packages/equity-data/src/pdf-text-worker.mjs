import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';

const pdfRoot=dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const maxPages=100;
const maxCharacters=500000;
const loading=getDocument({
  data:new Uint8Array(workerData),
  standardFontDataUrl:resolve(pdfRoot,'standard_fonts').replaceAll('\\','/')+'/',
  useSystemFonts:false,disableFontFace:true,isEvalSupported:false,useWasm:false,
  useWorkerFetch:false,stopAtErrors:true,verbosity:VerbosityLevel.ERRORS,
});
try {
  const document=await loading.promise;
  const lines=[];
  const warnings=[];
  let remaining=maxCharacters;
  let skippedPages=0;
  for(let pageNumber=1;pageNumber<=Math.min(maxPages,document.numPages)&&remaining>0;pageNumber++){
    const page=await document.getPage(pageNumber);
    const reader=page.streamTextContent().getReader();
    let line='',length=0;
    try{
      while(remaining>0){
        const part=await reader.read();
        if(part.done)break;
        for(const item of part.value.items){
          if(!('str' in item))continue;
          const text=item.str.slice(0,remaining);
          line+=text;length+=text.trim().length;remaining-=text.length;
          if(item.hasEOL){if(line.trim())lines.push(line);line='';remaining--;}
          if(remaining<=0)break;
        }
      }
      if(line.trim())lines.push(line);
      if(!length)skippedPages++;
    }finally{
      await reader.cancel().catch(()=>{});
      page.cleanup();
    }
  }
  if(document.numPages>maxPages||remaining<=0)warnings.push('PDF text truncated at 100 pages or 500000 characters.');
  if(skippedPages)warnings.push(`${skippedPages} PDF pages had no extractable text and were not indexed; OCR was not run.`);
  parentPort.postMessage({lines,warnings});
}catch{
  parentPort.postMessage(null);
}finally{
  await loading.destroy();
}
