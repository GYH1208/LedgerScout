import { resolve } from 'node:path';
import { loadConfig, projectRoot } from './config.js';
import { Results, redact } from './output.js';
import { Transport } from './http.js';
import { Api } from './api.js';
import { Checks } from './checks.js';

let activeSecrets: string[] = [];
async function main() {
  const cfg = loadConfig();
  const secrets = [cfg.alchemyKey, cfg.etherscanKey];
  activeSecrets = secrets;
  const log = (text: string) => console.log(redact(text, secrets));
  const command = process.argv[2] ?? 'all';
  const names = ['connectivity', 'balance', 'transactions', 'transfers'] as const;
  if (command === 'config') {
    log(JSON.stringify({ address: cfg.address, alchemyKeyPresent: Boolean(cfg.alchemyKey),
      etherscanKeyPresent: Boolean(cfg.etherscanKey), envPrecedence: 'process > project .env > workspace .env' }));
    return;
  }
  if (command !== 'all' && !(names as readonly string[]).includes(command)) {
    throw new Error('Usage: cli.ts all|connectivity|balance|transactions|transfers|config');
  }
  // Fail before network or output creation when any required credential is missing.
  const selected = command === 'all' ? [...names] : [command as typeof names[number]];
  const needsAlchemy = selected.some(n => n !== 'transactions') || (selected.includes('transactions') && cfg.endBlock === undefined);
  const missing = [needsAlchemy && !cfg.alchemyKey ? 'ALCHEMY_API_KEY' : '',
    selected.includes('transactions') && !cfg.etherscanKey ? 'ETHERSCAN_API_KEY' : ''].filter(Boolean);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}. Put keys in data-validation/.env locally, then rerun. No live requests were made.`);
  const results = new Results(resolve(projectRoot, 'results'), secrets);
  const transport = new Transport(cfg, async record => { await results.save(record.label, record); });
  const checks = new Checks(cfg, new Api(cfg, transport));
  const outcomes: Record<string, unknown> = {};
  log(`Read-only Ethereum Mainnet checks; address ${cfg.address}`);
  for (const name of selected) {
    try {
      const summary = await checks[name]();
      const path = await results.save(`${name}-summary`, summary);
      outcomes[name] = { status: 'passed', path };
      const concise = JSON.stringify(summary, (key, value) =>
        key === 'transactions' || key === 'transfers' ? undefined : value);
      log(`PASS ${name}: ${concise}\n  summary: ${path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const path = await results.save(`${name}-error`, { status: 'failed', error: message });
      outcomes[name] = { status: 'failed', error: message, path };
      log(`FAIL ${name}: ${message}\n  error: ${path}`);
      process.exitCode = 1;
    }
  }
  const manifest = await results.save('run-summary', { timestamp: new Date().toISOString(), address: cfg.address, outcomes });
  log(`Raw responses and normalized summaries: ${results.directory}\nRun manifest: ${manifest}`);
}
main().catch(error => {
  // Controlled config errors and redacted initialization messages, without stack traces.
  console.error(redact(error instanceof Error ? error.message : 'Initialization failed', activeSecrets));
  process.exitCode = 1;
});
