# ENS implementation ledger — 2026-11-12

## Scope and authorization

User requested direct implementation and then continuation. Executed inline on `feat/ens-resolution`, based on `c88945b`; no extra design approval gate. This feature remains uncommitted for review. Existing main baseline: 212 tests, 210 passed and 2 optional tokenizer tests skipped.

## Implementation and regression evidence

- Added pinned ENSIP-15 normalization and Keccak dependencies, fixed UniversalResolver ABI codec, strict scoped `eth_call`, immutable resolution proofs, and shared provider scheduling/budgets. Known namehash and ABI vectors, malformed replies, missing records, CCIP errors and arbitrary call refusal covered by chain-data tests.
- Added runtime preflight, ENS selection plus separate literal-address selection, proof hashes, fixed snapshots and checkpoint authorization. Regression tests cover failed lookups without old-target fallback, alias refresh, explicit-address replacement, mixed selections, historical evidence, cancellation, budget exhaustion and corrupted proofs.
- Failed assertions exposed assumptions about legal ENS punctuation and normalization. Adjusted fixtures to ENSIP-15 behavior; never strip legal internal punctuation or silently resolve a suffix.
- Real process-exit test exits after committed resolution and before the first model call. Resume completes using the original proof and snapshot, without another `eth_call`, with cumulative HTTP count 4.
- Initial live ENS-plus-flow run reached `CONTEXT_TOO_LARGE` after fetching a raw detail page. Added a regression, capped evidence pages to 2 records in flow-analysis rounds and compacted older evidence responses to query references. Full source evidence remains on disk and pagination reports actual `hasMore`. Repeated live run completed under unchanged budgets.

## Independent review

Final reviewer identified three Important issues: substring extraction could target a different name, name labels could affect balance/date intent, and mixed selections could lose literal addresses on refresh. Each received regression coverage and was fixed. Follow-up review confirmed all three resolved, 21 focused ENS tests passed, and no remaining Critical/Important/Minor in its reviewed scope. An additional explicit-name-plus-old-query ambiguity now clarifies before network or model calls. The final process-exit regression was verified separately afterward.

## Live acceptance

Public test name `vitalik.eth`, not a claim about user ownership. Existing local API configuration and process-scoped proxy used; no new credentials, tokenizer installation or system network changes.

| Request | Status | Model / tool / HTTP | Provider tokens |
| --- | --- | --- | --- |
| Current ETH balance | completed, fixed block 26396033 | 2 / 2 / 4 | 3570 input + 172 output = 3742 |
| Last-seven-days flow, first attempt | partial, context limit recorded | 4 / 6 / 12 | 9585 total |
| Last-seven-days flow, after fix | completed, fixed block 26396079 | 4 / 5 / 12 | 8837 input + 588 output = 9425 |

Both successful requests resolved to `0xd8da6bf26964af9d7eed9e03e53415d37aa96045`. Flow result: 29 incoming / 2 outgoing records, 17 assets and 23 peers, requested range traversed. Durable run-summary links are in [runtime integration](../../runtime-integration.md).

## Final verification

- `npm test`: 235 tests, 233 passed, 2 optional tokenizer tests skipped, 0 failures. Includes actual subprocess exit and recovery.
- `npm run typecheck`: root and data-validation checks both passed.
- `git diff --check`: passed.
- README, design, implementation plan and integration evidence updated.

Remaining product scope: only `.eth`/subdomains and on-chain ETH address records on Ethereum Mainnet; CCIP-Read gateway access, historical ENS binding reconstruction and background automatic recovery are not implemented.
