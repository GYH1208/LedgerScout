import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
function cli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'packages/agent-runtime/src/cli.ts', ...args], {
    cwd: root, env: { ...process.env, DEEPSEEK_API_KEY: '', ...env }, encoding: 'utf8', timeout: 10000,
  });
}
test('CLI missing model key fails before creating a run and reports a safe action', () => {
  const r = cli(['查余额']); assert.equal(r.status, 1); assert.match(r.stderr, /DEEPSEEK_API_KEY/);
});
test('CLI config only reports presence booleans and never credentials', () => {
  const r = cli(['--config'], { DEEPSEEK_API_KEY: 'offline-deepseek-secret' });
  assert.equal(r.status, 0); assert.ok(!r.stdout.includes('offline-deepseek-secret'));
  const data = JSON.parse(r.stdout); assert.equal(data.deepseekKeyPresent, true); assert.equal(data.provider, 'deepseek');
});
test('CLI supports help without credentials and rejects traversal sessions', () => {
  assert.equal(cli(['--help']).status, 0);
  const r = cli(['--session', '../escape', 'query'], { DEEPSEEK_API_KEY: 'offline-deepseek-secret' });
  assert.equal(r.status, 1); assert.match(r.stderr, /session/i);
});
