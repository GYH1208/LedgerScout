import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, ALCHEMY_API_KEY: '', ETHERSCAN_API_KEY: '' };

test('missing-key CLI fails visibly and says no live requests were made', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'all'], {
    cwd: root, env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ALCHEMY_API_KEY/);
  assert.match(result.stderr, /ETHERSCAN_API_KEY/);
  assert.match(result.stderr, /No live requests were made/);
});

test('config command reveals only presence booleans, never credentials', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'config'], {
    cwd: root, env: { ...env, ALCHEMY_API_KEY: 'offline-config-secret' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.includes('offline-config-secret'), false);
  const data = JSON.parse(result.stdout);
  assert.equal(data.alchemyKeyPresent, true);
  assert.equal(data.etherscanKeyPresent, false);
});
