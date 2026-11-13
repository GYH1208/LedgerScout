import { ensCandidates, maskEnsNames } from '@ledgerscout/chain-data';

// Ordinary English query words are not asset identifiers. Unrecognized Latin
// identifiers in a balance request require a contract rather than a stale binding.
const queryWords = new Set(('eth ethereum mainnet erc20 erc token tokens balance balances check show query get read find current latest for of the its their my your ' +
  'this that selected same previous last wallet account address holder please again refresh recheck what is are how much does hold holding holdings now ' +
  'at block number and with in on to an a me tell can you could would display as from has it these those our remaining total native ether wei gwei do i own portfolio').split(' '));

export function validTokenContracts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 4 && new Set(value).size === value.length && value.every(c => typeof c === 'string' && /^0x[0-9a-f]{40}$/.test(c));
}
export function extractTokenTargets(input: string): { holderInput: string; contracts: string[]; specified: boolean; tokenIntent: boolean; error?: string } {
  // Preserve positions while excluding ENS labels such as contract.eth from syntax parsing.
  let scan = input;
  for (const name of ensCandidates(input)) scan = scan.replace(name, ' '.repeat(name.length));
  const matches = [...scan.matchAll(/(?:(?:代币)?合约(?:地址)?|\b(?:token\s+)?contract(?:\s+address)?\b)\s*(?:[:：=]|为|是)?\s*([^\s,，;；]*)/gi)];
  const contracts: string[] = []; let holderInput = input; let error: string | undefined;
  for (const match of matches.reverse()) {
    const value = match[1]!;
    if (!/^0x[0-9a-f]{40}$/i.test(value)) error = '代币合约无效；请用“合约 0x完整地址”明确指定，不会沿用旧合约。';
    else if (!contracts.includes(value.toLowerCase())) contracts.unshift(value.toLowerCase());
    holderInput = holderInput.slice(0, match.index) + ' '.repeat(match[0].length) + holderInput.slice(match.index! + match[0].length);
  }
  if (contracts.length > 4) error = '每轮最多选择4个代币合约，请缩小范围。';
  const semantic = maskEnsNames(holderInput).replace(/q_[a-zA-Z0-9-]+/g, '').replace(/0x[a-zA-Z0-9]+/g, '');
  const words = semantic.match(/\b[a-z][a-z0-9_]*\b/gi) ?? [];
  const native = words.some(word => ['eth', 'ether', 'wei', 'gwei'].includes(word.toLowerCase()));
  const named = /余额|持仓|持有|\b(?:balances?|hold|holding|holdings|have|own|portfolio)\b/i.test(semantic) && words
    .some(word => !queryWords.has(word.toLowerCase()) && (!native || /^[A-Z][A-Z0-9]{1,11}$/.test(word)));
  if (named && !matches.length) error = '请明确提供代币合约地址；不能仅凭代币符号选择或沿用旧合约。';
  const tokenIntent = !!matches.length || named || /erc\s*20|代币|\btoken\b/i.test(semantic);
  return { holderInput, contracts: error ? [] : contracts, specified: !!matches.length, tokenIntent, ...(error ? { error } : {}) };
}
