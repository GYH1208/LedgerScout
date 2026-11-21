import {Worker} from 'node:worker_threads';

type TextResult={lines:string[];warnings:string[]};

export async function extractOfficialPdfText(bytes:Uint8Array,signal:AbortSignal):Promise<TextResult>{
  if(signal.aborted)throw Error('CANCELLED');
  const worker=new Worker(new URL('./pdf-text-worker.mjs',import.meta.url),{
    workerData:bytes,execArgv:[],resourceLimits:{maxOldGenerationSizeMb:96,maxYoungGenerationSizeMb:16},
    stdout:true,stderr:true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  const deadline=AbortSignal.timeout(12000);
  const aborted=AbortSignal.any([signal,deadline]);
  let onAbort=()=>{};
  try{
    const text=await new Promise<TextResult>((resolve,reject)=>{
      onAbort=()=>reject(Error(signal.aborted?'CANCELLED':'DOCUMENT_PDF_TIMEOUT'));
      aborted.addEventListener('abort',onAbort,{once:true});
      worker.once('message',message=>message?.lines?resolve(message):reject(Error('DOCUMENT_PDF_UNREADABLE')));
      worker.once('error',()=>reject(Error('DOCUMENT_PDF_UNREADABLE')));
      worker.once('exit',()=>reject(Error('DOCUMENT_PDF_UNREADABLE')));
      if(aborted.aborted)onAbort();
    });
    if(!text.lines.some(line=>line.trim()))throw Error('NO_EXTRACTABLE_TEXT');
    return text;
  }finally{
    aborted.removeEventListener('abort',onAbort);
    await worker.terminate();
  }
}
