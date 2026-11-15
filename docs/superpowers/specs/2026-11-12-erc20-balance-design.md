# ERC20 fixed-block balances

User authorized direct execution. Keep TypeScript, existing Alchemy transport, Pi tools, evidence and recovery. Work inline on `feat/erc20-balance`; no new dependencies. Commit/merge/push was separately authorized on 2026-11-13 after implementation review.

## Scope and approach

Accept a holder address or ENS and explicit token contract(s), up to four contracts per selection. Syntax labels each contract with `合约 [地址]` or `contract [address]`; an unlabelled holder address remains a holder. Persist holders/ENS and token contracts separately, reuse contract selection on follow-up and freeze it in checkpoints. Never infer a contract from a symbol or transfer history. Missing, invalid or ambiguous targets clarify before model/network work; a bad explicit selection never falls back to the previous one.

Use fixed-block `eth_call` for `balanceOf(address)` and `decimals()` (two RPCs per holder/contract, plus shared chain/snapshot bootstrap). Query kind/tool `get_erc20_balance(address, contractAddress, blockNumber?)` requires explicit authorized holder and contract. Preserve existing 8 model / 12 tool / 32 HTTP / 120-second limits, serial scheduling, retry/cancel behavior, redaction and durable evidence. Only allow exact two selectors and canonical calldata, no arbitrary call object, latest block, ETH value, state override or mutation methods.

Alternative Alchemy token endpoints would simplify metadata but do not fit the same fixed-block ABI contract; enumerating every held token is a separate feature. Selected approach adds no dependency/provider and keeps on-chain precision at one block.

Balance is a strictly decoded uint256, stored as decimal rawBalance. Decimals is an optional uint8 (0..255); amount is an exact decimal string computed with BigInt. Missing/reverted/invalid metadata or provider failure after balance preserves rawBalance and a partial result with reason, decimals=null and amount=null. Missing balance or invalid balance ABI is an error, never zero. Metadata failures remain subject to cancellation and HTTP budget. No symbol/name lookup, guessing, fiat valuation, enumeration or transfer-derived balance.

Official contracts: [ERC20](https://eips.ethereum.org/EIPS/eip-20) defines balanceOf and optional decimals; [Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/#eth_call) accepts a block parameter for eth_call. Query evidence includes holder, contract, block, raw balance, decimals, amount, metadata error and raw RPC responses. Contract address is the asset identity.

## Runtime, rendering and recovery

Names resolve as before. Contract labels are removed before holder extraction, including checkpoint ENS-literal validation. Only selected contracts authorize the new tool. Model prompt lists allowed holders and contracts separately. `token_balance` fact is rendered from validated raw integer/decimals; contract appears even on error and in fallback. Date ranges do not become historical balance ranges; use current snapshot or an explicit nonfuture block. Historical evidence access respects selected contracts unless the user explicitly selects its query ID; a new contract mixed with old ID and no refresh clarifies.

Checkpoint has optional tokenContracts; old checkpoints remain valid. Query references/hash/cache retain ERC20 results and contract identity. Completed calls replay without network; an incomplete query may repeat with original snapshot and cumulative counts. Session retains selected contracts separately from holder/ENS selections. Bad explicit contracts clear the contract selection so a later follow-up cannot silently reuse it.

## Verification

Independently specified selector/calldata and uint256 fixtures; zero/max uint256, decimals 0/6/18/255, malformed/empty/oversized words, metadata errors and no balance failure fallback. Fixed block, wrong chain, future block and arbitrary-call refusal. Real Pi integration for target separation, ENS, cross-turn contract change, wrong holder/contract denial, partial rendering, date guard, cached calls, budget/cancel and resume. Run full offline suite/typechecks, independent review, then bounded real public-holder/explicit-contract acceptance with durable evidence.
