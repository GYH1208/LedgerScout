import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '@ledgerscout/chain-data';
import { createDeepSeekRequest, loadRuntimeConfig } from './model.js';
import { runAgent } from './runtime.js';
import { validId } from './session.js';
import { createLocalTokenCounter, tokenizerDirectory } from './tokenizer.js';

let secrets: string[] = [];
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('LedgerScout: npm run agent -- [--session ID] [--json] [问题]\n恢复：--session ID --resume RUN_ID [--json]\n无问题参数时进入多轮命令行，/exit 退出。--config 仅检查配置。'); return;
  }
  let sessionId: string | undefined; let resumeRunId: string | undefined; let json = false; let configOnly = false; const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!;
    if (value === '--session') { sessionId = args[++i]; if (!sessionId || !validId(sessionId)) throw new Error('Invalid session ID'); }
    else if (value === '--resume') { resumeRunId = args[++i]; if (!resumeRunId || !validId(resumeRunId) || !/^r_/.test(resumeRunId)) throw new Error('Invalid resume run ID'); }
    else if (value === '--json') json = true;
    else if (value === '--config') configOnly = true;
    else if (value.startsWith('--')) throw new Error('Unknown CLI option; use --help');
    else words.push(value);
  }
  if (resumeRunId && (!sessionId || words.length || configOnly)) throw new Error('Resume requires --session and no new input / 问题');
  const config = loadRuntimeConfig();
  secrets = [config.key, config.chain.alchemyKey, config.chain.etherscanKey].filter(Boolean);
  if (configOnly) {
    console.log(JSON.stringify({ provider: 'deepseek', model: config.model, deepseekKeyPresent: Boolean(config.key),
      alchemyKeyPresent: Boolean(config.chain.alchemyKey), etherscanKeyPresent: Boolean(config.chain.etherscanKey),
      proxyPresent: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY), envProxyEnabled: process.env.NODE_USE_ENV_PROXY === '1' }));
    return;
  }
  const request = createDeepSeekRequest(config);
  const tokenizer = existsSync(join(tokenizerDirectory, 'ready.json')) ? createLocalTokenCounter({ model: config.model }) : undefined;
  async function run(input: string) {
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error('User cancelled'));
    process.on('SIGINT', interrupt);
    try {
      const result = await runAgent({ input, config: config.chain, request, outputDirectory: config.outputDirectory,
        ...(sessionId ? { sessionId } : {}), ...(resumeRunId ? { resumeRunId } : {}), signal: controller.signal, secrets, counter: tokenizer?.count,
        onEvent: e => { if (!json && e.type === 'tool_started') console.error(`查询中：${String(e.name)}`); },
      });
      sessionId = result.sessionId;
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(`${result.answer}\n\n状态：${result.status}\n会话：${result.sessionId}\n证据：${result.directory}`);
      process.exitCode = result.status === 'failed' || result.status === 'exhausted' ? 1 : result.status === 'cancelled' ? 130 : 0;
    } finally { process.off('SIGINT', interrupt); }
  }
  try {
    if (resumeRunId) { await run(''); return; }
    if (words.length) { await run(words.join(' ')); return; }
    if (json) throw new Error('--json requires a question argument');
    console.log('LedgerScout 就绪。输入问题；/exit 退出。');
    const input = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    for await (const line of input) {
      if (line.trim() === '/exit') { input.close(); break; }
      if (line.trim()) await run(line);
    }
  } finally { tokenizer?.close(); }
}
main().catch(error => {
  console.error(String(redact(error instanceof Error ? error.message : 'Runtime initialization failed', secrets)));
  process.exitCode = 1;
});
