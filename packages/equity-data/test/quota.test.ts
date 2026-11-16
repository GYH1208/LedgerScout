import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DailyQuota } from '../src/quota.js';

test('quota persists atomic reservations across connections and resets on UTC day', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'equity-quota-')), 'usage.sqlite');
  const a = new DailyQuota(path, 2), b = new DailyQuota(path, 2);
  const day = new Date('2026-11-16T23:59:59Z');
  a.reserve(day); b.reserve(day);
  assert.equal(a.usage(day), 2);
  assert.throws(() => a.reserve(day), /QUOTA_EXHAUSTED/);
  b.reserve(new Date('2026-11-17T00:00:00Z'));
  assert.equal(a.usage(new Date('2026-11-17T00:00:00Z')), 1);
  a.close(); b.close();
  const c = new DailyQuota(path, 2); assert.equal(c.usage(day), 2); c.close();
});
test('quota fails closed when storage unavailable', () => {
  const q = new DailyQuota(':memory:', 1); q.close();
  assert.throws(() => q.reserve(), /QUOTA_STORAGE/);
  assert.throws(() => new DailyQuota(':memory:', 201));
});
