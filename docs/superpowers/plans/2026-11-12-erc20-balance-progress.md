# ERC20 balance implementation — 2026-11-12

User requested direct implementation on `feat/erc20-balance`, base `06060c9`. Implementation was initially left uncommitted for review. On 2026-11-13 the user explicitly authorized commit, merge to main and push. No dependency added or tokenizer installed.

## Delivered

- Fixed-block ERC20 `balanceOf` plus optional `decimals`, canonical ABI whitelist, full uint256 precision and BigInt formatting (0..255 decimals).
- Separate holder/ENS and explicit contract selections (up to four), contract-aware cache and historical evidence, immutable query records and recovery authorization.
- Deterministic `token_balance` facts, raw units on missing metadata, contract identity on successful and failed results. No symbol/name metadata claims, token enumeration or fiat valuation.
- Existing dates, flows, ETH and checkpoint formats remain supported; ERC20 tool schema is only supplied when contracts are selected.

## Verification history

Baseline 235 tests: first attempt hit existing tokenizer fixture's 200ms worker startup timeout. Isolated tokenizer retry and unchanged complete retry passed (233 pass / 2 optional skips); no tokenizer production change.

Task 1: eight data tests failed against absent behavior, then passed. Complete suite 243 (241 pass / 2 skip) and types passed. Task 2: fourteen runtime tests initially twelve failed/two existing-path passes, then fourteen passed. Full suite found three compatibility regressions: extra schema exceeded estimated capacity for date recovery/flow paging; query-ID suffix was treated as a symbol. Existing failing tests verified fixes (inactive schema omitted; IDs masked), followed by full257=255pass2skip.

Independent review reported three Important findings: symbol-only requests could retain an old contract; ordinary English native-balance requests were incorrectly blocked; legacy recovery could inherit contracts selected in a later turn. Each was reproduced by a failing integration test before fixing. Extended cases include Chinese holdings wording, `USDC token balance`, `how much USDC do I hold?`, native ETH/wei requests and English contractions. Legacy regression explicitly removes tokenContracts from its saved checkpoint. Own additional failing test caught metadata evidence-storage failure being swallowed as optional precision; storage/checkpoint failures now propagate.

Final independent recheck approved the reviewed scope with no remaining Important/Critical, fresh26/26 focused tests. No Minor findings deferred. Reviewer declined external live acceptance and whole-suite conclusion; both were verified separately below.

## Live evidence

Both genuine DeepSeek + Alchemy runs completed on their first attempts, using an existing local proxy and configuration. Public holder `0xd8da6bf26964af9d7eed9e03e53415d37aa96045`; explicitly selected contract `0xdac17f958d2ee523a2206206994597c13d831ec7`. This is an acceptance fixture, not a user holding or identity claim.

| Input | Block | Exact result | Model/tool/HTTP | Provider tokens |
| --- | --- | --- | --- | --- |
| Direct holder + contract | 26396887 | raw291368220 / decimals6 / amount291.36822 | 2/1/4 | 4124+259=4383 |
| vitalik.eth + contract | 26396889 | same result; ENS and balance share block | 2/2/5 | 4192+263=4455 |

An independent script imported no production formatter and decoded saved raw eth_call results with BigInt division/remainder, matching both saved amounts and ENS holder/block. Durable [direct verification](../../../runtime-results/s_0f783610-1da9-4291-b793-e0c02de3261e/r_7db346d3-2e91-436f-a6e8-121a024807a1/token-verification.json) and [ENS verification](../../../runtime-results/s_c8dcdb07-d30d-4d6a-b2de-7fc400dd5ae8/r_3c418d03-3ceb-4fb6-8505-31784e62b296/token-verification.json). These links are local ignored evidence; source and test fixtures are tracked.

## Final checks and decisions

- `npm test`: 261 tests, 259 pass, 2 optional tokenizer skips, zero failures.
- `npm run typecheck`: root and data-validation passed.
- `git diff --check`: passed.
- All implementation checklist items complete. Integration authorized by the user on 2026-11-13; pre-commit full suite again passed (259 pass / 2 skips), both typechecks and diff check passed, and main/origin/main were synchronized before integration.

Ruling: unfamiliar Latin asset words in balance/holdings questions require an explicit contract. Ordinary query vocabulary and explicit native ETH/unit language remain supported; this conservative recognizer may ask for a clearer request on unfamiliar English prose instead of risking a stale asset selection.

Ruling: asset identity is the explicit contract, without friendly symbol/name lookup. This avoids claiming that a user-supplied address is an official named token; the tradeoff is less friendly output. All original budgets remain unchanged.
