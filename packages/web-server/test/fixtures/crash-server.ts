// Isolated offline subprocess used to kill the service at durable boundaries.
import { createWebServer } from '../../src/server.js';
import { cfg, offlineRun } from '../support.js';
const [dir,mode]=process.argv.slice(2);
if(!dir)throw Error('Missing isolated output directory');
let models=0;
const server=createWebServer({config:()=>cfg(dir),run:async o=>offlineRun({token:mode?.startsWith('token'),metadataError:mode==='token-partial',onModel:async()=>{
  if(++models===2&&mode==='checkpoint'){console.log('PAUSED');await new Promise<void>(()=>{});}
}})({...o,onEvent:e=>{
  o.onEvent?.(e);
  if(mode==='no-checkpoint'&&e.type==='run_started'){console.log('PAUSED');process.kill(process.pid,'SIGSTOP');}
}})});
server.listen(0,'127.0.0.1',async()=>{if(await server.ready)console.log('READY '+(server.address() as any).port);});
