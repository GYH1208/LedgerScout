# Implementation ledger — plan: docs/superpowers/plans/2026-11-15-web-live.md

## Authorization and scope

User requested real testing without visual adjustments. Continued inline on `feat/web-ui-prototype`, retaining the selected conversation layout and isolated demo mode. User configured the local .env and corrected the DeepSeek credential after the first authenticated request returned 401. Credentials were never printed or committed.

## Adapter and UI implementation

- Added loopback-only local HTTP adapter to existing runAgent. Global single-flight, bounded body/IDs/capacity, Origin/Host/client-header checks, registered run/query ownership, projected evidence pages of ten records, and no arbitrary file route.
- Added independent `?mode=live` view, real result text with queryId links, actual completeness/ranges, exact balances and raw evidence, progress, cancellation and explicit Runtime recovery. Real view has no seeded facts or demo fallback.
- Added local launcher and Vite proxy. Proxy environment variables are inherited only by the API child; system settings are unchanged.
- Web views persist in the local service process, and Runtime evidence remains on disk. No persistent Web index or deployment was added.

## Verification

- Latest root `npm test`: 245 total, 243 passed, 2 optional tokenizer skips, zero failures.
- Root and data-validation typecheck: passed. Prototype build: passed. Prototype local tests: 7/7.
- Six adapter tests cover origin/body/config boundaries, exact balance and evidence ownership, cancellation/explicit resume, actual Pi Runtime execution with offline provider responses and matching durable summary, plus bounded transfer pagination/raw units.
- Original demo browser checks: 16 passed, no console errors or external requests.
- Live browser checks using explicitly intercepted offline transport: exact balance, reference panel, stale-response invalidation, cancel/recovery availability, session refresh and mobile evidence drawer passed. These are not real supplier acceptance.
- Missing-config live page verified with no seed sessions and disabled submission. Screenshots and fixture report are in `docs/design/qa/live-*`.

## Independent review and fixes

Reviewer found two P2 issues. A delayed old evidence request could reopen a cleared panel; the browser race regression failed before incrementing the evidence sequence on submission, then passed. A consumed source run still advertised resumable; an HTTP regression failed before effective availability was projected into state, then passed. Added refresh sequencing to prevent older polling responses overwriting newer state. No additional material boundary issue was reported.

## Real supplier acceptance — 2026-11-15

All three credentials are configured. Explicit `npm --prefix apps/research-prototype run test:live` exercised DeepSeek, Alchemy and Etherscan through the rendered Chrome UI and existing Pi Runtime. It passed its bounded acceptance assertions; this includes supported partial results and does not mean every upstream request succeeded.

Authoritative acceptance record: `runtime-results/web-live_2026-11-15T06-51-49-147Z/acceptance.json`. Session: `s_aa3142b1-62e3-42b6-a0a6-236a7e99383d`. Provider-reported token totals below cover this final three-turn attempt, not earlier diagnostic attempts.

| Question | Runtime result | Model / tool / data HTTP | Reported tokens |
| --- | --- | --- | --- |
| vitalik.eth current ETH balance | completed, `r_c3352bc9-bbae-4b9d-b484-c0985ecc2e53` | 2 / 2 / 4 | 3,766 |
| Last seven days of funds flow | partial, `r_3843af3a-8f78-48b7-bd5a-39e51d048602` | 5 / 4 / 17 | 13,249 |
| Explain existing query without refresh | completed, `r_edc54820-6bcb-44ea-b55e-c09d6818446c` | 1 / 0 / 0 | 2,576 |

- ENS resolved to `0xd8da6bf26964af9d7eed9e03e53415d37aa96045`. Balance query `q_a3e701be-0a4a-4a55-93e1-ae43175e5ec4` at block 26418723 returned exactly `5798969845714110716` wei (`5.798969845714110716` ETH); the answer and evidence UI preserve precision.
- Successful transfer query `q_38e93c2b-6131-4f3c-b85f-3dda975c535f` verified the fixed window 2026-11-08 14:51:55 through 2026-11-15 14:51:55 Asia/Shanghai, blocks 26368477–26418723. Its incoming/outgoing traversals are complete: 26 incoming and 2 outgoing records; 16 assets and 22 counterparties. ETH net transfer amount is `0.005151311946066805`, excluding gas; this is not profit or balance change.
- The first Etherscan end-block response returned 26418722 even though block 26418723 also precedes the requested end time. Alchemy boundary verification correctly rejected it. A model retry returned 26418723 and succeeded. The original failed query `q_c58a1081-e044-43e5-becd-9acd11a9dffb` remains visible and the whole turn stays **partial**. No boundary check or budget was relaxed to obtain a pass.
- The follow-up selected the successful historical query and issued **zero data HTTP requests**. Browser/API answers matched their durable run-summary files, and browser page errors were empty.
- Additional read-only validation is saved beside acceptance as `evidence-checks.json`: all 28 unique raw records paginated 10 → 20 → 28 in Chrome, exact integer sums and net amounts matched all 16 assets, and the verified boundary proof matched the fixed time window. Desktop and 390 × 844 mobile captures were inspected (`flow-status-desktop.png`, `flow-paginated-desktop.png`, `flow-evidence-mobile.png`). Mobile session reopening after reload passed; no horizontal page overflow or browser errors. These inspections made no additional provider requests. Actual state responses were checked for absence of the configured secret values without printing them.

### Real-testing defects repaired

1. A previous follow-up could not reuse its explicit query because the word “刷新” inside “不要刷新数据” was treated as a positive freshness request. Added failing-then-passing Chinese/English regressions for negated refresh, plus a case ensuring a separate positive “当前余额” still requires fresh data. Session/address/date/query authorization remains authoritative.
2. An earlier seven-day attempt reached `CONTEXT_TOO_LARGE`: old tool-result text had been shortened, but assistant tool-call arguments and message framing kept accumulating. Added a failing capacity regression at the original 10,000-token input budget, then compacted complete older flow-only call/result batches into re-readable query references. Mixed, incomplete and error batches remain; the latest batch retains its pairing. Focused tests and the full suite pass. Independent source review found no actionable issue. Recovery after this particular whole-batch compaction is not a separately exercised end-to-end test; existing cancellation/recovery tests still pass.

Earlier failed attempts remain in ignored `runtime-results/web-live_*` folders. They are diagnostic records, not replaced or represented as successful acceptance.

Local live preview: `http://127.0.0.1:4173/?mode=live`; API bound to `127.0.0.1:4174`. Changes remain uncommitted.
