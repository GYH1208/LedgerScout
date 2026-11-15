import type { Api } from './api.js';
import { ApiError } from './http.js';

const address = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
// Only ERC20 balanceOf(address) and decimals() at an explicit block. No other call options.
export function isTokenEthCall(params: unknown[]): boolean {
  if (params.length !== 2) return false;
  const [call, block] = params as [{ to?: unknown; data?: unknown }, unknown];
  return !!call && Object.keys(call).sort().join(',') === 'data,to' && address(call.to) &&
    typeof block === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(block) &&
    typeof call.data === 'string' && /^0x(?:313ce567|70a082310{24}[0-9a-f]{40})$/i.test(call.data);
}
export function decodeTokenWord(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) throw new ApiError('Response validation: invalid ERC20 uint256 ABI word');
  return BigInt(value);
}
export function formatTokenAmount(rawBalance: string, decimals: number): string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(rawBalance) || rawBalance.length > 78 || BigInt(rawBalance) >= 2n ** 256n ||
    !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new ApiError('Response validation: invalid ERC20 amount/decimals');
  if (!decimals) return rawBalance;
  const padded = rawBalance.padStart(decimals + 1, '0');
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
export async function readTokenBalance(api: Api, holder: string, contract: string, block: number): Promise<{
  rawBalance: string; decimals: number | null; amount: string | null; error?: string;
}> {
  if (!address(holder) || !address(contract) || !Number.isSafeInteger(block) || block < 0) throw new Error('INVALID_ARGUMENT: invalid ERC20 query');
  const tag = `0x${block.toString(16)}`;
  const rawBalance = decodeTokenWord(await api.rpc('eth_call', [{ to: contract, data: '0x70a08231' + holder.slice(2).toLowerCase().padStart(64, '0') }, tag])).toString();
  try {
    const precision = decodeTokenWord(await api.rpc('eth_call', [{ to: contract, data: '0x313ce567' }, tag]));
    if (precision > 255n) throw new ApiError('Response validation: invalid ERC20 decimals uint8');
    const decimals = Number(precision);
    return { rawBalance, decimals, amount: formatTokenAmount(rawBalance, decimals) };
  } catch (error) {
    // Transport/API failures can leave a useful raw amount. Storage/checkpoint
    // failures are not optional metadata and must still fail the query.
    if (!(error instanceof ApiError) && !(error instanceof Error && /\bbudget\b|cancel|abort|timeout/i.test(error.message))) throw error;
    return { rawBalance, decimals: null, amount: null, error: error instanceof Error ? error.message : 'ERC20 decimals unavailable' };
  }
}
