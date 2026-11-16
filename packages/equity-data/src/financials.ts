import type { FinancialPoint, Financials } from './types.js';

const DAY = 86_400_000;
const concepts: Record<string, string[]> = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment'],
  cash: ['CashAndCashEquivalentsAtCarryingValue'], assets: ['Assets'], liabilities: ['Liabilities'],
  dilutedEps: ['EarningsPerShareDiluted'],
};
const instant = new Set(['cash', 'assets', 'liabilities']);
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const days = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / DAY + 1;
const quarterDuration = (p: FinancialPoint) => !!p.start && days(p.start, p.end) >= 70 && days(p.start, p.end) <= 110;
const annualDuration = (p: FinancialPoint) => !!p.start && days(p.start, p.end) >= 350 && days(p.start, p.end) <= 380;

export function specialIndustry(industry?: string): string | undefined {
  if (!industry) return undefined;
  if (/\b(bank|banks|banking)\b/i.test(industry)) return 'bank';
  if (/insurance|insurer/i.test(industry)) return 'insurance';
  if (/\breit\b|real estate investment trust/i.test(industry)) return 'REIT';
  return undefined;
}

/** SEC USD US-GAAP facts only. Never infer currency conversion or custom-taxonomy equivalence. */
export function normalizeFinancials(companyFacts: unknown, industry?: string): Financials {
  const root = record(record(record(companyFacts)?.facts)?.['us-gaap']);
  const warnings = new Set<string>();
  const annual: FinancialPoint[] = [], quarterly: FinancialPoint[] = [];
  const all: { point: FinancialPoint; tag: string; priority: number }[] = [];
  const sourceId = (tag: string, p: FinancialPoint) => `us-gaap:${tag}|${p.accession}|${p.start ?? ''}/${p.end}|${p.unit}`;
  if (!root) warnings.add('No supported US-GAAP company facts available.');
  for (const [metric, tags] of Object.entries(concepts)) for (const [priority, tag] of tags.entries()) {
    const units = record(record(root?.[tag])?.units);
    const expectedUnit = metric === 'dilutedEps' ? 'USD/shares' : 'USD';
    if (units && Object.keys(units).some(unit => unit !== expectedUnit)) warnings.add(`${metric}: unsupported units omitted; expected ${expectedUnit}.`);
    const rows = units?.[expectedUnit];
    if (!Array.isArray(rows)) continue;
    for (const entry of rows) {
      const row = record(entry);
      if (!row || !validDate(row.end) || !validDate(row.filed) || typeof row.val !== 'number' || !Number.isFinite(row.val)
        || typeof row.accn !== 'string' || !row.accn || typeof row.form !== 'string' || !/^10-[KQ](\/A)?$/.test(row.form)) continue;
      if (instant.has(metric) ? row.start !== undefined : !validDate(row.start)) continue;
      if (typeof row.start === 'string' && row.start > row.end) continue;
      const point: FinancialPoint = { metric, value: row.val, unit: expectedUnit, end: row.end, filed: row.filed, accession: row.accn, form: row.form };
      if (typeof row.start === 'string') point.start = row.start;
      if (typeof row.fy === 'number') point.fiscalYear = row.fy;
      if (typeof row.fp === 'string') point.fiscalPeriod = row.fp;
      point.derivedFrom = [sourceId(tag, point)];
      all.push({point, tag, priority});
    }
  }
  // Select restatements within a concept before selecting among equivalent supported concepts.
  const selected = new Map<string, typeof all[number]>();
  const ambiguous = new Set<string>();
  for (const row of all.sort((a, b) => a.point.filed.localeCompare(b.point.filed) || a.point.accession.localeCompare(b.point.accession))) {
    const p = row.point, key = `${row.tag}|${p.unit}|${p.start ?? ''}|${p.end}`;
    const previous = selected.get(key);
    if (previous && previous.point.filed === p.filed && previous.point.value !== p.value) ambiguous.add(key);
    else if (!previous || previous.point.filed < p.filed) ambiguous.delete(key);
    selected.set(key, row);
  }
  const final = new Map<string, typeof all[number]>();
  for (const [rawKey,row] of selected) {
    if (ambiguous.has(rawKey)) { warnings.add(`Ambiguous latest filing-day values omitted for ${row.point.metric} ending ${row.point.end}.`); continue; }
    const p = row.point, key = `${p.metric}|${p.unit}|${p.start ?? ''}|${p.end}`;
    const old = final.get(key);
    if (!old || row.point.filed > old.point.filed || row.point.filed === old.point.filed && row.priority < old.priority) final.set(key, row);
  }
  const rows = [...final.values()];
  const annualEnds = new Set(rows.filter(r => annualDuration(r.point)).map(r => r.point.end));
  for (const {point} of rows) {
    if (instant.has(point.metric)) {
      if (annualEnds.has(point.end) || point.form.startsWith('10-K') && point.fiscalPeriod === 'FY') annual.push(point);
      quarterly.push(point);
    } else {
      if (annualDuration(point)) annual.push(point);
      if (quarterDuration(point)) quarterly.push(point);
    }
  }
  for (const row of rows) {
    const p = row.point;
    if (!p.start || p.metric === 'dilutedEps' || quarterDuration(p)) continue;
    const earlier = rows.filter(other => other.tag === row.tag && other.point.unit === p.unit && other.point.start === p.start && other.point.filed <= p.filed
      && other.point.end < p.end && days(other.point.end, p.end) - 1 >= 70 && days(other.point.end, p.end) - 1 <= 110)
      .sort((a, b) => b.point.end.localeCompare(a.point.end))[0]?.point;
    if (!earlier) continue;
    const start = new Date(Date.parse(earlier.end) + DAY).toISOString().slice(0, 10);
    if (quarterly.some(other => other.metric === p.metric && other.start === start && other.end === p.end && other.unit === p.unit)) continue;
    quarterly.push({...p, start, value: p.value - earlier.value, filed: p.filed > earlier.filed ? p.filed : earlier.filed,
      fiscalPeriod: annualDuration(p) ? 'Q4' : p.fiscalPeriod, derivedFrom: [...(p.derivedFrom ?? []), ...(earlier.derivedFrom ?? [])]});
  }
  const trim = (points: FinancialPoint[], limit: number) => {
    const counts = new Map<string, number>();
    return points.sort((a,b) => b.end.localeCompare(a.end) || a.metric.localeCompare(b.metric)).filter(p => {
      const count = counts.get(p.metric) ?? 0; counts.set(p.metric, count + 1); return count < limit;
    });
  };
  const industryExclusion = specialIndustry(industry);
  if (industryExclusion) warnings.add(`General-company ratio comparison excluded for ${industryExclusion} reporting.`);
  return {annual:trim(annual,3),quarterly:trim(quarterly,8),warnings:[...warnings],...(industryExclusion ? {industryExclusion} : {})};
}
