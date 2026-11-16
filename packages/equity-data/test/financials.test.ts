import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFinancials } from '../src/financials.js';

const fact = (start: string | undefined, end: string, val: number, extra = {}) => ({ ...(start ? { start } : {}), end, val, filed: '2025-02-01', accn: 'a', form: '10-K', fy: 2024, fp: 'FY', ...extra });
const facts = (entries: Record<string, unknown>) => ({ facts: { 'us-gaap': entries } });
const usd = (rows: unknown[]) => ({ units: { USD: rows } });

test('formula definitions do not turn otherwise supported facts into data-gap warnings',()=>{
  const result=normalizeFinancials(facts({Revenues:usd([fact('2024-01-01','2024-12-31',100)])}));
  assert.deepEqual(result.warnings,[]);
});

test('latest restatement wins for the same metric, unit and exact period', () => {
  const result = normalizeFinancials(facts({ Revenues: usd([
    fact('2024-01-01', '2024-12-31', 100), fact('2024-01-01', '2024-12-31', 120, { filed: '2025-03-01', accn: 'amended', form: '10-K/A' }),
  ]) }));
  assert.equal(result.annual[0]?.value, 120);
  assert.equal(result.annual[0]?.accession, 'amended');
});

test('YTD cash flows produce single quarters and Q4 with both source accessions', () => {
  const result = normalizeFinancials(facts({ NetCashProvidedByUsedInOperatingActivities: usd([
    fact('2024-01-01', '2024-03-31', 10, { form: '10-Q', fp: 'Q1', accn: 'q1' }),
    fact('2024-01-01', '2024-06-30', 30, { form: '10-Q', fp: 'Q2', accn: 'q2' }),
    fact('2024-01-01', '2024-09-30', 60, { form: '10-Q', fp: 'Q3', accn: 'q3' }),
    fact('2024-01-01', '2024-12-31', 100),
  ]) }));
  assert.deepEqual(result.quarterly.map(p => [p.start, p.end, p.value]), [
    ['2024-10-01', '2024-12-31', 40], ['2024-07-01', '2024-09-30', 30],
    ['2024-04-01', '2024-06-30', 20], ['2024-01-01', '2024-03-31', 10],
  ]);
  assert.ok(result.quarterly[0]?.derivedFrom?.some(s => s.includes('q3')));
});

test('incoherent currencies, mismatched starts, and EPS YTD are never subtracted', () => {
  const result = normalizeFinancials(facts({
    Revenues: { units: { USD: [fact('2024-01-01', '2024-06-30', 30)], EUR: [fact('2024-01-01', '2024-03-31', 10)] } },
    NetIncomeLoss: usd([fact('2024-01-02', '2024-03-31', 10), fact('2024-01-01', '2024-06-30', 30)]),
    EarningsPerShareDiluted: { units: { 'USD/shares': [fact('2024-01-01', '2024-03-31', 1), fact('2024-01-01', '2024-06-30', 3)] } },
  }));
  assert.equal(result.quarterly.filter(p => p.start === '2024-04-01').length, 0);
});

test('caps history at three annual and eight quarterly periods per metric', () => {
  const rows = Array.from({ length: 5 }, (_, i) => fact(`${2020+i}-01-01`, `${2020+i}-12-31`, i));
  const result = normalizeFinancials(facts({ Revenues: usd(rows) }));
  assert.deepEqual(result.annual.map(p => p.end), ['2024-12-31','2023-12-31','2022-12-31']);
});

test('ignores malformed facts and flags special financial reporting industries', () => {
  assert.deepEqual(normalizeFinancials(null).annual, []);
  const malformed = normalizeFinancials(facts({ Assets: usd([fact(undefined, 'nonsense', 1), fact(undefined, '2024-12-31', Infinity)]) }));
  assert.equal(malformed.annual.length, 0);
  for (const industry of ['Diversified Banks', 'Insurance - Life', 'REIT - Retail']) assert.ok(normalizeFinancials({}, industry).industryExclusion);
});

test('a later restatement of the YTD baseline cannot be subtracted from an older annual filing', () => {
  const result=normalizeFinancials(facts({ Revenues:usd([
    fact('2024-01-01','2024-09-30',100,{filed:'2025-03-01',accn:'recast'}),
    fact('2024-01-01','2024-12-31',120),
  ]) }));
  assert.equal(result.quarterly.length,0);
});

test('capital-expenditure concept cannot silently substitute acquisitions or broad investing flows', () => {
  const result=normalizeFinancials(facts({PaymentsToAcquireBusinessesNetOfCashAcquired:usd([fact('2024-01-01','2024-12-31',50)]),NetCashProvidedByUsedInInvestingActivities:usd([fact('2024-01-01','2024-12-31',-80)])}));
  assert.equal(result.annual.some(p=>p.metric==='capex'),false);
});

test('quarter history caps at eight and direct reported quarters override YTD differences', () => {
  const rows=Array.from({length:10},(_,i)=>{const year=2022+Math.floor(i/4),quarter=i%4;const starts=['01-01','04-01','07-01','10-01'],ends=['03-31','06-30','09-30','12-31'];return fact(`${year}-${starts[quarter]}`,`${year}-${ends[quarter]}`,i);});
  const result=normalizeFinancials(facts({Revenues:usd(rows)}));
  assert.equal(result.quarterly.length,8);assert.equal(result.quarterly.at(-1)?.end,'2022-09-30');
  const direct=normalizeFinancials(facts({Revenues:usd([fact('2024-01-01','2024-03-31',10),fact('2024-01-01','2024-06-30',35),fact('2024-04-01','2024-06-30',30)])}));
  assert.equal(direct.quarterly.find(p=>p.start==='2024-04-01')?.value,30);
});

test('ambiguous latest filing-day values are omitted instead of picking an arbitrary winner', () => {
 const result=normalizeFinancials(facts({Revenues:usd([
   fact('2024-01-01','2024-12-31',100,{accn:'first'}),fact('2024-01-01','2024-12-31',120,{accn:'second'}),
 ])}));
 assert.equal(result.annual.length,0);assert.ok(result.warnings.some(w=>/ambiguous/i.test(w)));
});
