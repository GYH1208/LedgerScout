import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDateWindow } from '../src/dates.js';
const now = new Date('2026-11-12T01:00:00Z');
for (const [input, start, end] of [
  ['最近七天的交易', '2026-11-05T01:00:00Z', '2026-11-12T01:00:00Z'],
  ['past 2 hours transfers', '2026-11-11T23:00:00Z', '2026-11-12T01:00:00Z'],
  ['近二十一天', '2026-10-22T01:00:00Z', '2026-11-12T01:00:00Z'],
  ['昨天的转账', '2026-11-10T16:00:00Z', '2026-11-11T15:59:59Z'],
  ['今天', '2026-11-11T16:00:00Z', '2026-11-12T01:00:00Z'],
  ['上周', '2026-11-01T16:00:00Z', '2026-11-08T15:59:59Z'],
  ['本周', '2026-11-08T16:00:00Z', '2026-11-12T01:00:00Z'],
  ['上月', '2026-09-30T16:00:00Z', '2026-10-31T15:59:59Z'],
  ['2026-11-01 至 2026-11-03', '2026-10-31T16:00:00Z', '2026-11-03T15:59:59Z'],
  ['2024年2月29日', '2024-02-28T16:00:00Z', '2024-02-29T15:59:59Z'],
  ['昨天收到的转账', '2026-11-10T16:00:00Z', '2026-11-11T15:59:59Z'],
  ['last seven days transfers to 0x1111111111111111111111111111111111111111', '2026-11-05T01:00:00Z', '2026-11-12T01:00:00Z'],
  ['from 2026-11-01 to 2026-11-03 transfers', '2026-10-31T16:00:00Z', '2026-11-03T15:59:59Z'],
] as const) test(`date window ${input}`, () => {
  const parsed = parseDateWindow(input, now); assert.equal(parsed.error, undefined); assert.ok(parsed.window);
  assert.equal(parsed.window.startTimestamp, Date.parse(start) / 1000);
  assert.equal(parsed.window.endTimestamp, Date.parse(end) / 1000);
  assert.equal(parsed.window.timezone, 'Asia/Shanghai');
});
for (const input of ['2026-02-29', '2026-13-01', '最近0天', '最近半年', '本周三', '昨天和今天',
  '2026-11-05到2026-11-01', '2027-01-01', '最近七天 区块 100 到 200', '昨天 UTC', '2026-11-01 12:30', 'last seven months',
  'last week', 'this month', '2026-11-01 和 2026-11-03', '2026-11-01 到下周', 'yesterday evening', '2026-11-01T12:00:00Z']) {
  test(`ambiguous or invalid date clarifies: ${input}`, () => { assert.ok(parseDateWindow(input, now).error); });
}
test('future end is clipped explicitly and non-date requests remain unchanged', () => {
  const p = parseDateWindow('2026-11-01至2027-01-01', now); assert.ok(p.window?.clipped);
  assert.equal(p.window.endTimestamp, now.getTime() / 1000);
  assert.deepEqual(parseDateWindow('查余额和上次查询', now), {});
});
for (const input of ['2026-11-01之前的转账', 'since 2026-11-01 transfers', '2026-11-01 到 11-03', '2026-11-01 PST',
  '昨天和last month', '过去七天，从第100个区块开始', '最近7天前的交易', '2026-11-01 Europe/London']) test(`unsupported qualifier cannot be discarded: ${input}`, () => {
  assert.ok(parseDateWindow(input, now).error);
});
test('record recency is independent of a date window', () => {
  assert.deepEqual(parseDateWindow('最近50条交易', now), {});
});
test('calendar dates use Shanghai across a UTC day boundary', () => {
  const p = parseDateWindow('昨天', new Date('2026-11-11T23:00:00Z'));
  assert.equal(p.window?.startTimestamp, Date.parse('2026-11-10T16:00:00Z') / 1000);
});
test('query identifiers cannot be mistaken for date expressions', () => {
  assert.deepEqual(parseDateWindow('查看上次证据 q_aaaa-1234-56ef-9988 的余额', now), {});
});
