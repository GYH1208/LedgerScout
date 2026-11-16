import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEquityConfig, configurationStatus } from '../src/config.js';

test('config loads only supplied dotenv and environment wins without exposing secrets', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'equity-config-')), '.env');
  writeFileSync(file, 'FMP_API_KEY=file-secret\nSEC_USER_AGENT=Research researcher@domain.org\nFMP_DAILY_LIMIT=17\n');
  const config = loadEquityConfig({ FMP_API_KEY: 'process-secret' }, [file]);
  assert.equal(config.fmpKey, 'process-secret');
  assert.equal(config.dailyLimit, 17);
  assert.deepEqual(configurationStatus(config), { market: 'missing-TWELVE_DATA_API_KEY', fmp: 'configured-unverified', sec: 'configured-unverified', dailyLimit: 17,twelveDataDailyLimit:600 });
  assert.equal(JSON.stringify(configurationStatus(config)).includes('secret'), false);
});
test('config rejects placeholders, invalid user agent and unsafe budget', () => {
  for (const env of [{ SEC_USER_AGENT: 'LedgerScout' }, { SEC_USER_AGENT: 'tool a@example.com' }, { FMP_DAILY_LIMIT: '201' }, { FMP_API_KEY: 'YOUR_KEY' },{TWELVE_DATA_API_KEY:'YOUR_KEY'},{TWELVE_DATA_DAILY_LIMIT:'801'}]) {
    assert.throws(() => loadEquityConfig(env, []));
  }
  assert.equal(loadEquityConfig({}, []).secUserAgent, '');
});
