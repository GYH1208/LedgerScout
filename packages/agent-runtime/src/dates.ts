import { maskEnsNames, type TimeWindow } from '@ledgerscout/chain-data';
const day = 86400; const offset = 8 * 3600;
const error = () => ({ error: '日期范围不明确或不受支持。请使用最近N小时/天/周、今天/昨天、自然周/月或 YYYY-MM-DD 起止日期；日历日期按北京时间，日期不能与显式区块同时指定。' });
function numeric(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text === '十') return 10;
  if (digits[text]) return digits[text];
  if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(text)) {
    const [tens, units] = text.split('十'); return (tens ? digits[tens]! : 1) * 10 + (units ? digits[units]! : 0);
  }
  const english: Record<string, number> = { one: 1, two: 2, three: 3, seven: 7 };
  return english[text.toLowerCase()] ?? NaN;
}
export function parseDateWindow(input: string, now: Date): { window?: TimeWindow; error?: string } {
  input = maskEnsNames(input);
  input = input.replace(/\b[qsrm]_[A-Za-z0-9_-]+\b/g, '').replace(/0x[0-9a-fA-F]+/g, '');
  input = input.replace(/(?:最近|过去|近)\s*[零〇一二两三四五六七八九十百\d]+\s*(?:条|笔)/g, '');
  const absolute = [...input.matchAll(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/g)];
  const rolling = [...input.matchAll(/(?:最近|过去|近)\s*([零〇一二两三四五六七八九十百\d]+)\s*(小时|天|周)|\b(?:last|past)\s+(\d+|one|two|three|seven)\s+(hours?|days?|weeks?)\b/gi)];
  const calendar = [...input.matchAll(/今天|昨天|前天|本周|上周|本月|上月|\btoday\b|\byesterday\b/gi)];
  const unsupported = /下周|下月|明天|后天|今年|去年|\b(?:morning|afternoon|evening|tonight)\b/i.test(input);
  const temporalHint = /最近|过去|近.{0,6}(?:天|周|月|年|小时)|本周|上周|本月|上月|星期|礼拜|\d{4}[-/.年]\d|\b(?:last|past|this|previous)\s+(?:\w+\s+)?(?:days?|hours?|weeks?|months?|years?)\b/i;
  const dateIntent = unsupported || absolute.length || rolling.length || calendar.length || temporalHint.test(input);
  if (!dateIntent) return {};
  if (unsupported) return error();
  if (/(?:区块|blocks?|startBlock|endBlock)[^，。；,\n]{0,12}\d|\d+\s*个?\s*(?:区块|blocks?)|\b(?:UTC|GMT|PST|PDT|EST|EDT|CST|CDT|CET|CEST|BST|JST)\b|\b(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc|US|Canada)\/[A-Za-z_]+|时区|\d{1,2}:\d{2}|\d+点|凌晨|上午|下午|晚上|[点时]钟|(?:周|星期)[一二三四五六日天]/i.test(input)) return error();
  const count = (absolute.length ? 1 : 0) + rolling.length + calendar.length;
  if (count !== 1 || absolute.length > 2) return error();
  if (absolute.length === 2 && !/^\s*(?:至|到|[-–—~～]|to|through)\s*$/i.test(input.slice(absolute[0]!.index! + absolute[0]![0].length, absolute[1]!.index))) return error();
  let remaining = input;
  for (const m of [...absolute, ...rolling, ...calendar].sort((a, b) => b.index! - a.index!)) remaining = remaining.slice(0, m.index!) + '__DATE__' + remaining.slice(m.index! + m[0].length);
  if (temporalHint.test(remaining) || /之前|以前|之后|以后|以来|截至|截止|开始|结束|\b(?:since|before|after|until)\b|\d{1,2}[-/.]\d{1,2}|__DATE__\s*[前后起]/i.test(remaining) ||
    absolute.length !== 2 && /(?:从|\bfrom\s+)__DATE__|__DATE__\s*(?:至|到|to\b|through\b)/i.test(remaining)) return error();
  const referenceTimestamp = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(referenceTimestamp)) return error();
  let start: number; let end: number;
  const local = new Date((referenceTimestamp + offset) * 1000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) / 1000 - offset;
  if (rolling.length) {
    const m = rolling[0]!; const n = numeric(m[1] ?? m[3]!); const unit = m[2] ?? m[4]!;
    if (!Number.isSafeInteger(n) || n < 1 || n > 36500) return error();
    start = referenceTimestamp - n * (/小时|hour/i.test(unit) ? 3600 : /周|week/i.test(unit) ? 7 * day : day);
    end = referenceTimestamp;
  } else if (absolute.length) {
    const parse = (m: RegExpMatchArray) => {
      const year = Number(m[1]); const month = Number(m[2]); const date = Number(m[3]);
      const utc = new Date(Date.UTC(year, month - 1, date));
      return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === date ? utc.getTime() / 1000 - offset : NaN;
    };
    start = parse(absolute[0]!); end = parse(absolute.at(-1)!) + day - 1;
  } else {
    const label = calendar[0]![0].toLowerCase(); end = referenceTimestamp;
    if (['今天', 'today'].includes(label)) start = midnight;
    else if (['昨天', 'yesterday', '前天'].includes(label)) { start = midnight - (label === '前天' ? 2 : 1) * day; end = start + day - 1; }
    else if (label.includes('周')) { start = midnight - ((local.getUTCDay() + 6) % 7) * day; if (label === '上周') { end = start - 1; start -= 7 * day; } }
    else { start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth()) / 1000 - offset; if (label === '上月') { end = start - 1; start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1) / 1000 - offset; } }
  }
  if (![start, end].every(Number.isSafeInteger) || start < 1 || start > end || start > referenceTimestamp) return error();
  return { window: { startTimestamp: start, endTimestamp: Math.min(end, referenceTimestamp), referenceTimestamp,
    timezone: 'Asia/Shanghai', clipped: end > referenceTimestamp } };
}
