import { ens_normalize } from '@adraffy/ens-normalize';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ApiError } from './http.js';
export const UNIVERSAL_RESOLVER = '0xeeeeeeee14d718c2b47d9923deab1335e144eeee';
// Validate complete tokens first, including legal internal punctuation.
// Only surrounding presentation wrappers may be removed after that fails.
export const ensCandidates = (input: string) => input.split(/\s+/u).filter(token => /\.eth/i.test(token)).map(token => {
  try { normalizeEnsName(token); return token; } catch { /* Try outer wrappers only. */ }
  const wrappers = [['(', ')'], ['[', ']'], ['{', '}'], ['<', '>'], ['【', '】'], ['"', '"'], ["'", "'"], ['`', '`'], ['“', '”'], ['‘', '’']];
  let candidate = token.replace(/[,，。!?！？;；]+$/u, '');
  for (let i = 0; i < 4; i++) {
    const pair = wrappers.find(([left, right]) => candidate.startsWith(left!) && candidate.endsWith(right!) && candidate.length > 2);
    if (!pair) break;
    candidate = candidate.slice(pair[0]!.length, -pair[1]!.length);
  }
  return candidate;
});
export function maskEnsNames(input: string): string {
  for (const candidate of ensCandidates(input)) input = input.replace(candidate, '');
  return input;
}
export const ensSelector = (signature: string) => Buffer.from(keccak_256(Buffer.from(signature))).toString('hex').slice(0, 8);
const word = (n: number) => n.toString(16).padStart(64, '0');
const invalidName = (): never => { throw new Error('INVALID_ENS: 请提供有效的 .eth 名称；名称与指令间请留空格。'); };
const invalidResult = (): never => { throw new ApiError('Response validation: invalid ENS ABI result'); };
export function normalizeEnsName(input: string): string {
  try {
    const name = ens_normalize(input);
    if (!name.endsWith('.eth') || name === 'eth' || Buffer.byteLength(name) > 255 || name.split('.').some(l => !l || Buffer.byteLength(l) > 255)) return invalidName();
    return name;
  } catch { return invalidName(); }
}
export function ensNamehash(input: string): string {
  let node = new Uint8Array(32);
  for (const label of ens_normalize(input).split('.').reverse()) node = new Uint8Array(keccak_256(Buffer.concat([node, keccak_256(Buffer.from(label))])));
  return '0x' + Buffer.from(node).toString('hex');
}
const encodeBytes = (hex: string) => word(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
export function encodeEnsCall(input: string): string {
  const name = normalizeEnsName(input);
  const dns = name.split('.').map(l => { const bytes = Buffer.from(l); return Buffer.concat([Buffer.from([bytes.length]), bytes]); });
  const first = encodeBytes(Buffer.concat([...dns, Buffer.from([0])]).toString('hex'));
  const second = encodeBytes('3b3b57de' + ensNamehash(name).slice(2));
  return '0x9061b923' + word(64) + word(64 + first.length / 2) + first + second;
}
export function isEnsEthCall(params: unknown[]): boolean {
  try {
    const [call, block] = params as [{ to: string; data: string }, string];
    if (params.length !== 2 || !call || Object.keys(call).sort().join(',') !== 'data,to' ||
      typeof call.to !== 'string' || call.to.toLowerCase() !== UNIVERSAL_RESOLVER || typeof call.data !== 'string' ||
      !/^0x9061b923[0-9a-f]+$/i.test(call.data) || call.data.length > 4096 || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(block)) return false;
    const raw = Buffer.from(call.data.slice(10), 'hex');
    if (raw.length < 128 || BigInt('0x' + raw.subarray(0, 32).toString('hex')) !== 64n) return false;
    const size = Number(BigInt('0x' + raw.subarray(64, 96).toString('hex')));
    if (!Number.isSafeInteger(size) || size < 1 || size > 257 || 96 + size > raw.length) return false;
    const dns = raw.subarray(96, 96 + size); const labels: string[] = []; let i = 0;
    while (i < dns.length && dns[i]) { const n = dns[i++]!; if (i + n >= dns.length) return false; labels.push(new TextDecoder('utf-8', { fatal: true }).decode(dns.subarray(i, i + n))); i += n; }
    if (i !== dns.length - 1 || dns[i] !== 0) return false;
    return encodeEnsCall(labels.join('.')).toLowerCase() === call.data.toLowerCase();
  } catch { return false; }
}
export function decodeEnsResult(value: unknown): { address: string | null; resolver: string } {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{256}$/i.test(value)) return invalidResult();
  const hex = value.slice(2).toLowerCase();
  if (hex.slice(0, 64) !== word(64) || hex.slice(128, 192) !== word(32) || !/^0{24}/.test(hex.slice(64, 128)) || !/^0{24}/.test(hex.slice(192))) return invalidResult();
  const resolver = '0x' + hex.slice(88, 128); const address = '0x' + hex.slice(216, 256);
  if (/^0x0{40}$/.test(resolver)) return invalidResult();
  return { resolver, address: /^0x0{40}$/.test(address) ? null : address };
}
